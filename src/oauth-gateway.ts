/**
 * The OAuth credential path, as one thing that is either wholly present or
 * absent — and the single function that decides what goes upstream.
 *
 * Two rules meet here, and both are absolute:
 *
 *  - MCP forbids passthrough. "An MCP server MUST NOT accept any tokens that
 *    were not explicitly issued for the MCP server", and it must obtain its own
 *    credential for anything it calls upstream.
 *  - The api accepts only Keycloak tokens whose `azp` is in
 *    KEYCLOAK_ALLOWED_CLIENTS (MEE-866). Widening that is not an option; it is
 *    what stops any browser-obtainable public client counting as user auth.
 *
 * So a JWT is worth exactly nothing to us until it has been validated
 * (token-validation.ts) AND exchanged (token-exchange.ts). The earlier shape of
 * this code kept the two as independent optionals and ran whichever happened to
 * be configured, which meant a deployment missing either one forwarded the
 * client's own token to the api — the one thing the spec forbids outright, and
 * the default state of the chart. The fix is structural rather than a new
 * check: validation and exchange are one method on one object that only exists
 * when every part of the configuration does, and {@link resolveUpstreamToken}
 * returns its argument on exactly one branch — the one that has already
 * recognised the credential as one meetergo issued.
 */
import { isMeetergoCredential } from './client.js'
import { logDiagnostic, safeText } from './diagnostics.js'
import { TokenExchanger } from './token-exchange.js'
import { TokenValidator, type ValidatedToken } from './token-validation.js'

/**
 * What the JWT branch needs: one call that both proves the token was minted for
 * us and hands back a different one. Deliberately not "a validator and an
 * exchanger" — the interface is the invariant.
 */
export interface OAuthCredentialSource {
  credentialFor(jwt: string): Promise<string>
}

/**
 * What the HTTP layer needs from the OAuth path: a credential, and the
 * authorization server to point clients at. One value carrying both is what
 * keeps discovery and token handling from disagreeing about whether this
 * deployment offers OAuth.
 */
export interface OAuthSupport extends OAuthCredentialSource {
  readonly issuer: string
}

export interface OAuthGatewayConfig {
  /** Realm issuer, e.g. https://login.meetergo.com/realms/meetergo */
  issuer: string
  /** Confidential client this server exchanges tokens as. */
  clientId: string
  clientSecret: string
  /** Canonical MCP endpoint URL; an accepted token must name it in `aud`. */
  audience: string
}

/** The HTTP status a failure carries, when it carries one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { status } = error as { status?: unknown }
  return typeof status === 'number' ? status : undefined
}

export class OAuthGateway implements OAuthSupport {
  readonly issuer: string
  private readonly audience: string
  private readonly clientId: string
  private readonly validator: TokenValidator
  private readonly exchanger: TokenExchanger

  constructor(config: OAuthGatewayConfig) {
    this.issuer = config.issuer
    this.audience = config.audience
    this.clientId = config.clientId
    this.validator = new TokenValidator({
      issuer: config.issuer,
      audience: config.audience,
    })
    this.exchanger = new TokenExchanger({
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    })
  }

  /**
   * Prove, then replace. The order matters as much as the pair: exchanging
   * first would make this server a confused deputy, turning anything the realm
   * ever signed into a credential the api trusts.
   */
  async credentialFor(jwt: string): Promise<string> {
    let claims: ValidatedToken
    try {
      claims = await this.validator.validate(jwt)
    } catch (error) {
      // Both sides of the comparison, because the failure mode this catches in
      // practice is a missing Keycloak audience mapper, which otherwise reads
      // as "401 for every user" with nothing anywhere saying why. The reason
      // quotes claims out of a token nobody has verified yet — untrusted text,
      // hence safeText — while the expected values are our own configuration.
      logDiagnostic('warn', 'oauth_token_rejected', {
        reason: safeText(error),
        // 401 is the presented token; 502 is the realm being unreachable. They
        // have opposite fixes, and only this field tells a dashboard which of
        // the two a burst of failures is.
        status: statusOf(error),
        expectedIssuer: this.issuer,
        expectedAudience: this.audience,
      })
      throw error
    }

    try {
      return await this.exchanger.exchange(jwt)
    } catch (error) {
      // Past validation the claims are realm-signed, so they are as trustworthy
      // as anything else we log. `azp` is the fact that separates "this one
      // client is not permitted to exchange" from "our own client is wrong",
      // and those have opposite fixes.
      logDiagnostic('warn', 'oauth_exchange_failed', {
        reason: safeText(error),
        // 401 = the user's token is spent, 502 = our client or the realm's
        // exchange policy is wrong. Only the second is a page-someone problem.
        status: statusOf(error),
        subject: claims.sub,
        authorizedParty: claims.azp,
        exchangeClient: this.clientId,
      })
      throw error
    }
  }
}

export interface OAuthEnvironment {
  issuer?: string
  clientId?: string
  clientSecret?: string
  /** Canonical MCP endpoint URL. Always known; it is derived from MCP_PUBLIC_URL. */
  audience: string
}

/**
 * OAUTH_ISSUER, checked at boot the way MCP_PUBLIC_URL is
 * (oauth-metadata.ts) — loudly, and before a single request.
 *
 * A malformed issuer is otherwise invisible until the first OAuth user tries to
 * connect, where it surfaces as a 502 on the JWKS fetch of every request. A
 * plaintext-http one is never visible at all, and is worse: the token exchange
 * posts this server's client secret and the user's access token to it, so the
 * whole point of holding a confidential client is lost to anyone on the path.
 *
 * The trailing slash is trimmed rather than rejected because `iss` is compared
 * byte for byte (token-validation.ts) and Keycloak never emits one — leaving it
 * in place would reject every token with a message about issuers that look
 * identical.
 */
function normalizeIssuer(issuer: string): string {
  let url: URL
  try {
    url = new URL(issuer)
  } catch (error) {
    throw new Error(
      `OAUTH_ISSUER must be an absolute https URL, got "${issuer}" (${String(error)})`,
    )
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `OAUTH_ISSUER must be https, got "${issuer}". The token exchange sends this server's client secret and the user's access token to it.`,
    )
  }
  return issuer.replace(/\/+$/, '')
}

/**
 * All three, or nothing.
 *
 * A half-configured deployment is not "OAuth with a piece missing", it is a
 * deployment that cannot finish the flow, and the only safe reading of one is
 * that OAuth is not on offer at all: discovery stays 404 and a JWT is refused.
 * Anything softer walks clients into an authorize loop whose resulting token
 * this server would then have no way to use.
 */
export function createOAuthGateway(
  env: OAuthEnvironment,
): OAuthGateway | undefined {
  const issuer = env.issuer?.trim()
  const clientId = env.clientId?.trim()
  const clientSecret = env.clientSecret?.trim()
  if (issuer && clientId && clientSecret) {
    return new OAuthGateway({
      issuer: normalizeIssuer(issuer),
      clientId,
      clientSecret,
      audience: env.audience,
    })
  }

  const missing = Object.entries({
    OAUTH_ISSUER: issuer,
    OAUTH_CLIENT_ID: clientId,
    OAUTH_CLIENT_SECRET: clientSecret,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name)

  // Bearer-token-only (nothing set) is a supported deployment and says nothing.
  // A PARTIAL configuration is the dangerous one: the operator believes OAuth
  // is on. Variable names only — never the values.
  if (missing.length < 3) {
    logDiagnostic('warn', 'oauth_disabled_incomplete_config', {
      missing,
      effect:
        'OAuth is not offered: discovery answers 404 and OAuth access tokens are refused. Personal Access Tokens and Platform API Keys are unaffected.',
    })
  }
  return undefined
}

/**
 * The answer to an OAuth token on a deployment that does not offer OAuth.
 *
 * 401 rather than 501 or 503: nothing here is temporary or unimplemented, the
 * resource simply does not accept this credential, which is what 401 means. It
 * also keeps the reply in the one shape every MCP client already parses. The
 * challenge sent with it deliberately carries no `resource_metadata` — there is
 * no authorization server to discover, and naming one we do not serve would
 * send the client round a flow that cannot succeed.
 */
export class OAuthNotSupportedError extends Error {
  readonly status = 401

  constructor() {
    // ASCII only: this message is also the RFC 6750 error_description, and the
    // header escaping (printable ASCII, no quotes) would eat anything else.
    super(
      'This deployment does not accept OAuth access tokens. Use a meetergo Personal Access Token (prefix rgo-) from https://my.meetergo.com/integrations.',
    )
    this.name = 'OAuthNotSupportedError'
  }
}

/**
 * The credential to send upstream, for whatever the client presented.
 *
 * The shape is the guarantee. `token` is returned on exactly one branch, and
 * that branch has already recognised it as a credential meetergo issued — a
 * Personal Access Token (`rgo-…`) or a Platform API Key (`ak_live:…`), both of
 * which the api verifies itself and must receive untouched. Everything else
 * goes down validate-then-exchange, which fails closed on anything it cannot
 * account for: with OAuth unconfigured it throws, and with OAuth configured a
 * string that is not a realm-signed token naming this server does not survive
 * validation. So what leaves here is a credential the caller already held from
 * us, or the string {@link OAuthCredentialSource.credentialFor} produced, or a
 * throw. There is no third way out, which is the point.
 *
 * The test that decides is an allowlist ({@link isMeetergoCredential}) for the
 * same reason. As a denylist it read "not shaped like a JWT, therefore ours",
 * and a five-segment compact JWE, a four-segment token or `a..c` are all not
 * shaped like a JWT — every one of them was forwarded to the api verbatim.
 */
export async function resolveUpstreamToken(
  token: string,
  oauth: OAuthCredentialSource | undefined,
): Promise<string> {
  if (isMeetergoCredential(token)) return token
  if (!oauth) throw new OAuthNotSupportedError()
  return oauth.credentialFor(token)
}
