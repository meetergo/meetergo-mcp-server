/**
 * Inbound OAuth token validation — proving a token was minted for US.
 *
 * The MCP authorization spec makes this a MUST, not a nicety: "MCP servers MUST
 * only accept tokens specifically intended for themselves and MUST reject
 * tokens that do not include them in the audience claim." Skipping it turns
 * this server into a confused deputy, because it holds a confidential client
 * secret that upgrades a token into one the api trusts (token-exchange.ts) —
 * so any realm token anyone could get delivered here would come back out as
 * full meetergo user auth.
 *
 * The check is therefore: RS256 signature against the realm JWKS, `iss` equal
 * to our realm, `typ: "Bearer"` (an ID token is proof of login for some client,
 * not an api credential), `aud` containing our canonical endpoint URL, and an
 * unexpired lifetime. Only then does the exchange run.
 *
 * Implemented on node:crypto rather than a JWT library on purpose: this package
 * is published to npm and run by end users, so every dependency added here is
 * theirs too, and Node ≥20 already imports a JWK straight into a KeyObject and
 * verifies RSASSA-PKCS1-v1_5 natively. The one failure classically worth a
 * library — algorithm confusion — is closed by pinning `alg` to a single value
 * before any key is selected.
 */
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto'

/**
 * Keycloak's default access-token signature algorithm, and the only one the api
 * accepts either (`algorithms: ['RS256']` in keycloak-verifier.ts). Pinned to a
 * single value so a token can never choose its own verification path.
 */
const JWT_ALG = 'RS256'
const NODE_SIGNATURE_ALG = 'RSA-SHA256'

/** Tolerated clock drift between this pod and the realm, in seconds. */
const CLOCK_SKEW_SECONDS = 30

/** How long a fetched JWKS is reused before it is refetched. */
const JWKS_TTL_MS = 10 * 60_000
/**
 * Floor between JWKS fetch ATTEMPTS. Without it, a stream of tokens naming
 * random `kid`s would turn every request into a round-trip to the realm.
 *
 * Deliberately global rather than per-caller: the only per-request throttle in
 * front of this is the rate limiter in http-app.ts, which buckets by bearer
 * token — a value an unauthenticated stranger rotates for free, so it bounds
 * nothing here. This does: one round trip per pod per interval, however many
 * distinct tokens arrive.
 */
const JWKS_MIN_INTERVAL_MS = 30_000
/**
 * And longer after a failure, with the failure itself replayed in between.
 *
 * A realm that just timed out will not answer differently a moment later, and
 * every attempt costs another JWKS_TIMEOUT_MS with a connection held open on a
 * request that is going to fail anyway. Without this, a realm outage turned
 * each JWT-shaped request — free to send, and free to make unique — into a
 * five-second wait on Keycloak.
 */
const JWKS_FAILURE_BACKOFF_MS = 60_000
const JWKS_TIMEOUT_MS = 5_000

export interface TokenValidatorConfig {
  /** Realm issuer, e.g. https://login.meetergo.com/realms/meetergo */
  issuer: string
  /** Canonical MCP endpoint URL; an accepted token must name it in `aud`. */
  audience: string
}

/** The claims this server acts on, after they have been proven. */
export interface ValidatedToken {
  sub: string
  /** Client the token was issued to. Informational — the api re-pins it after the exchange. */
  azp?: string
}

/**
 * `status` is what the HTTP layer should answer: 401 when the presented token
 * is the problem (re-authorizing fixes it), 502 when the realm is the problem
 * (re-authorizing does not, and telling the client otherwise loops it).
 */
export class TokenValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TokenValidationError'
  }
}

interface JwtHeader {
  alg?: string
  kid?: string
}

interface JwtClaims {
  iss?: string
  aud?: string | string[]
  sub?: string
  typ?: string
  azp?: string
  exp?: number
  nbf?: number
}

/** A JWKS entry. Intersecting with JsonWebKey keeps it usable by createPublicKey unchanged. */
type JwksEntry = JsonWebKey & { kid?: string; use?: string; alg?: string }

/**
 * The base64url alphabet, and nothing else.
 *
 * JWS compact serialisation is BASE64URL segments joined by dots (RFC 7515
 * §7.1), so a segment containing anything outside this set is not a JWT and
 * refusing it loses no real token. Refusing is also what makes the signing input
 * unambiguous: the bytes used to be taken with Node's 'ascii' encoding, which
 * TRUNCATES each UTF-16 code unit to a byte instead of rejecting it, so 'A'
 * (U+0041) and 'Ł' (U+0141) sign identically and two different segment strings
 * can share one signature. Checked before any bytes are taken, so the encoding
 * no longer decides anything.
 */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/

function isBase64UrlSegment(segment: string): boolean {
  return BASE64URL_SEGMENT.test(segment)
}

function decodeSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T
  } catch {
    throw new TokenValidationError(`Token ${what} is not readable JSON`, 401)
  }
}

export class TokenValidator {
  private readonly jwksUri: string
  private keys = new Map<string, KeyObject>()
  /** Last SUCCESSFUL fetch — what the cache TTL is measured from. */
  private fetchedAt = 0
  /** Last attempt of either kind — what the throttle is measured from. */
  private attemptedAt = 0
  /** The last failure, replayed for as long as the backoff window lasts. */
  private failure?: TokenValidationError
  private inFlight?: Promise<void>

  constructor(private readonly config: TokenValidatorConfig) {
    this.jwksUri = `${config.issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`
  }

  /** Verify a Keycloak access token, or throw {@link TokenValidationError}. */
  async validate(token: string): Promise<ValidatedToken> {
    const segments = token.split('.')
    if (segments.length !== 3 || !segments.every(isBase64UrlSegment)) {
      throw new TokenValidationError('Token is not a JWT', 401)
    }
    const [rawHeader, rawClaims, rawSignature] = segments

    const header = decodeSegment<JwtHeader>(rawHeader, 'header')
    // Before the key lookup, so `alg: "none"` and HMAC-over-the-public-key can
    // never reach a verifier that would honour them.
    if (header.alg !== JWT_ALG) {
      throw new TokenValidationError(
        `Token is signed with ${header.alg ?? 'no algorithm'}, expected ${JWT_ALG}`,
        401,
      )
    }
    if (!header.kid) {
      throw new TokenValidationError('Token header carries no kid', 401)
    }

    const key = await this.keyFor(header.kid)
    // utf8, now that both segments are known to be base64url: for ASCII input it
    // is byte-for-byte the string, and unlike 'ascii' it has no lossy path at
    // all to fall back on if that assumption is ever weakened.
    const signed = Buffer.from(`${rawHeader}.${rawClaims}`, 'utf8')
    const signature = Buffer.from(rawSignature, 'base64url')
    if (!verifySignature(NODE_SIGNATURE_ALG, signed, key, signature)) {
      throw new TokenValidationError(
        'Token signature does not verify against the realm JWKS',
        401,
      )
    }

    return this.assertClaims(decodeSegment<JwtClaims>(rawClaims, 'payload'))
  }

  private assertClaims(claims: JwtClaims): ValidatedToken {
    if (claims.iss !== this.config.issuer) {
      throw new TokenValidationError(
        `Token issuer ${claims.iss ?? 'missing'} is not ${this.config.issuer}`,
        401,
      )
    }
    if (claims.typ !== 'Bearer') {
      throw new TokenValidationError('Token is not an access token', 401)
    }

    // The MUST. Keycloak has no RFC 8707 resource indicators, so the audience
    // arrives from an Audience mapper on the `mcp-audience` client SCOPE (not
    // the `mcp` client — they are different objects and only the scope carries
    // the mapper). If that scope is unattached, or its mapper names a different
    // string, this is where it surfaces: as a blanket 401 on every OAuth call.
    const audiences =
      typeof claims.aud === 'string' ? [claims.aud] : (claims.aud ?? [])
    if (!audiences.includes(this.config.audience)) {
      throw new TokenValidationError(
        `Token audience [${audiences.join(', ')}] does not include ${this.config.audience}`,
        401,
      )
    }

    const now = Math.floor(Date.now() / 1000)
    if (typeof claims.exp !== 'number') {
      throw new TokenValidationError('Token carries no expiry', 401)
    }
    if (claims.exp + CLOCK_SKEW_SECONDS <= now) {
      throw new TokenValidationError('Token has expired', 401)
    }
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
      throw new TokenValidationError('Token is not valid yet', 401)
    }
    if (!claims.sub) {
      throw new TokenValidationError('Token carries no subject', 401)
    }

    return { sub: claims.sub, azp: claims.azp }
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const cached = this.keys.get(kid)
    if (cached && Date.now() - this.fetchedAt < JWKS_TTL_MS) return cached

    try {
      await this.refresh()
    } catch (error) {
      // A stale but known key beats failing every call while the realm is
      // unreachable — signing keys rotate on the order of months.
      if (cached) return cached
      throw error
    }

    const key = this.keys.get(kid)
    if (!key) {
      throw new TokenValidationError(`Realm JWKS has no signing key ${kid}`, 401)
    }
    return key
  }

  /**
   * At most one JWKS fetch per window, whatever the request volume.
   *
   * Two windows, because the two outcomes deserve different patience. After a
   * success the shorter one stands, so a token naming a `kid` from a fresh
   * rotation is only briefly wrong. After a failure the longer one does, and
   * inside it the remembered error is replayed rather than earned again — that
   * is the difference between a realm outage costing this pod one round trip a
   * minute and costing it one per request.
   */
  private async refresh(): Promise<void> {
    const since = Date.now() - this.attemptedAt
    if (this.failure) {
      if (since < JWKS_FAILURE_BACKOFF_MS) throw this.failure
    } else if (since < JWKS_MIN_INTERVAL_MS) {
      return
    }
    // One fetch serves every request that piles up behind it; a stateless
    // server sees the whole burst of an agent's parallel tool calls at once.
    this.inFlight ??= this.fetchKeys().finally(() => {
      this.inFlight = undefined
    })
    await this.inFlight
  }

  private async fetchKeys(): Promise<void> {
    this.attemptedAt = Date.now()
    try {
      this.keys = await this.loadKeys()
      this.fetchedAt = Date.now()
      this.failure = undefined
    } catch (error) {
      this.failure =
        error instanceof TokenValidationError
          ? error
          : new TokenValidationError(
              `Could not read the realm JWKS at ${this.jwksUri}: ${String(error)}`,
              502,
            )
      throw this.failure
    }
  }

  private async loadKeys(): Promise<Map<string, KeyObject>> {
    let response: Response
    try {
      response = await fetch(this.jwksUri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      })
    } catch (error) {
      throw new TokenValidationError(
        `Could not reach the realm JWKS at ${this.jwksUri}: ${String(error)}`,
        502,
      )
    }
    if (!response.ok) {
      throw new TokenValidationError(
        `Realm JWKS at ${this.jwksUri} answered ${response.status}`,
        502,
      )
    }

    let keys: Map<string, KeyObject>
    try {
      const body = (await response.json()) as { keys?: JwksEntry[] }
      keys = new Map(
        (body.keys ?? [])
          // Signature keys only. A Keycloak realm also publishes its RSA-OAEP
          // encryption key, which must never end up verifying a token.
          .filter(
            (jwk) =>
              jwk.kty === 'RSA' &&
              jwk.kid &&
              (jwk.use ?? 'sig') === 'sig' &&
              (jwk.alg ?? JWT_ALG) === JWT_ALG,
          )
          .map((jwk) => [
            jwk.kid as string,
            createPublicKey({ key: jwk, format: 'jwk' }),
          ]),
      )
    } catch (error) {
      throw new TokenValidationError(
        `Realm JWKS at ${this.jwksUri} is not usable: ${String(error)}`,
        502,
      )
    }
    if (keys.size === 0) {
      throw new TokenValidationError(
        `Realm JWKS at ${this.jwksUri} published no ${JWT_ALG} signing key`,
        502,
      )
    }

    return keys
  }
}
