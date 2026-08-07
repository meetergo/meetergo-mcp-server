/**
 * Keycloak standard token exchange (RFC 8693) — the bridge between an OAuth
 * MCP client and the api's client allowlist.
 *
 * Why this exists at all: the MCP spec forbids token passthrough outright — an
 * MCP server "MUST NOT accept any tokens that were not explicitly issued for
 * the MCP server" and must obtain its own credential for anything upstream. The
 * api enforces the same thing from its side: it accepts only Keycloak tokens
 * whose `azp` is in `KEYCLOAK_ALLOWED_CLIENTS` (MEE-866,
 * apps/api/src/app/auth/functions/token-claims.ts), a deliberate pin, because
 * without it any browser-obtainable public client of the realm would count as
 * full user auth. The token an MCP client holds is minted for the public OAuth
 * client it authorized against, so forwarding it always 401s with "Token client
 * is not allowed".
 *
 * The fix is NOT to widen the allowlist — a wildcard there re-opens exactly
 * what MEE-866 closed. Instead this server, which holds a confidential client
 * secret no MCP client has, exchanges the incoming user token for one minted
 * for the `mcp` client. Keycloak preserves the subject, so the api still
 * resolves the same user through auth_identity; it just sees a known `azp`.
 *
 * The exchange runs only on a token token-validation.ts has already proven was
 * issued for this server. Exchanging first would make us a confused deputy:
 * anything the realm signed would come back out as an api-accepted credential.
 *
 * What gets here is decided in oauth-gateway.ts: meetergo's own credentials
 * (Personal Access Tokens, Platform API Keys) are verified by the api directly
 * and pass through untouched, everything else arrives here having already been
 * validated. This module never decides that itself — a second copy of that rule
 * is a second chance to get it backwards.
 */

const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

/** Re-exchange this many seconds before expiry rather than racing the clock. */
const EXPIRY_SKEW_SECONDS = 30

/**
 * A stalled realm must not hold an MCP request open indefinitely: the host has
 * no way to cancel a tool call, so an unbounded wait parks the agent.
 */
const EXCHANGE_TIMEOUT_MS = 10_000

/**
 * Bounded so a burst of distinct tokens cannot grow the process's memory
 * without limit. Entries are short-lived anyway (a Keycloak access token is
 * minutes), so eviction of the oldest is cheap and self-correcting.
 */
const MAX_CACHE_ENTRIES = 1000

export interface TokenExchangeConfig {
  /** Realm issuer, e.g. https://login.meetergo.com/realms/meetergo */
  issuer: string
  clientId: string
  clientSecret: string
}

/** Seconds-until-expiry from a JWT's `exp`, or null if unreadable. */
function expiresInSeconds(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp?: number }
    if (typeof payload.exp !== 'number') return null
    return payload.exp - Math.floor(Date.now() / 1000)
  } catch {
    return null
  }
}

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TokenExchangeError'
  }
}

/**
 * Which of the two failure modes a Keycloak refusal is.
 *
 * `invalid_grant` / `invalid_token` mean the user's token is spent — 401, and
 * the MCP client re-runs the OAuth flow. `invalid_client` and
 * `unauthorized_client` mean OUR secret is wrong or the realm does not permit
 * this exchange, and no amount of re-authorizing the user fixes that: answering
 * 401 there walks the client through an authorize loop forever against a
 * deployment that is simply misconfigured, with nothing in our logs saying so.
 */
function refusalStatus(httpStatus: number, body: string): number {
  let code: unknown
  try {
    code = (JSON.parse(body) as { error?: unknown }).error
  } catch {
    code = undefined
  }
  if (
    code === 'invalid_client' ||
    code === 'unauthorized_client' ||
    code === 'access_denied'
  ) {
    return 502
  }
  return httpStatus === 400 || httpStatus === 401 ? 401 : 502
}

export class TokenExchanger {
  private readonly endpoint: string
  private readonly cache = new Map<
    string,
    { token: string; expiresAt: number }
  >()
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(private readonly config: TokenExchangeConfig) {
    this.endpoint = `${config.issuer.replace(/\/+$/, '')}/protocol/openid-connect/token`
  }

  /**
   * Exchange a realm-issued user token for one minted for this client.
   *
   * Cached by the subject token: an agent run fires many tool calls with the
   * same credential, and a Keycloak round-trip on each would put the realm on
   * the hot path of every request. Safe as a cache key because the exchange is
   * a pure function of it — same subject, same resulting identity — and because
   * token-validation.ts has already proven the subject unexpired before we get
   * here, so a cached entry can never outlive a credential the caller may no
   * longer present.
   */
  async exchange(subjectToken: string): Promise<string> {
    const hit = this.cache.get(subjectToken)
    if (hit) {
      if (hit.expiresAt > Date.now()) return hit.token
      // Drop it now rather than waiting for cap pressure to evict it; otherwise
      // dead entries sit in the map for the lifetime of the pod.
      this.cache.delete(subjectToken)
    }

    // Agents fire tool calls in parallel on one credential. Without this, the
    // first burst opens one Keycloak round-trip per call, all of them racing to
    // populate the same cache entry.
    const pending = this.inFlight.get(subjectToken)
    if (pending) return pending

    const request = this.requestExchange(subjectToken).finally(() => {
      this.inFlight.delete(subjectToken)
    })
    this.inFlight.set(subjectToken, request)
    return request
  }

  private async requestExchange(subjectToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: EXCHANGE_GRANT,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
    })

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      })
    } catch (error) {
      // An unreachable realm is our outage, not the user's bad token.
      throw new TokenExchangeError(
        `Could not reach Keycloak at ${this.endpoint}: ${String(error)}`,
        502,
      )
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new TokenExchangeError(
        `Keycloak refused the token exchange (${response.status}): ${detail.slice(0, 200)}`,
        refusalStatus(response.status, detail),
      )
    }

    const payload = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    const exchanged = payload.access_token
    if (!exchanged) {
      throw new TokenExchangeError(
        'Keycloak returned no access_token for the exchange',
        502,
      )
    }

    // Cache against the EXCHANGED token's own expiry, not the subject's: the
    // exchanged token is the one we hand upstream, so it decides when the entry
    // stops being usable. `expires_in` is the authoritative answer (RFC 6749);
    // its `exp` claim is the fallback for a realm that omits it.
    const ttl =
      typeof payload.expires_in === 'number'
        ? payload.expires_in
        : expiresInSeconds(exchanged)
    if (ttl !== null && ttl > EXPIRY_SKEW_SECONDS) {
      while (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      this.cache.set(subjectToken, {
        token: exchanged,
        expiresAt: Date.now() + (ttl - EXPIRY_SKEW_SECONDS) * 1000,
      })
    }

    return exchanged
  }
}
