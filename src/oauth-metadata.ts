/**
 * RFC 9728 protected-resource metadata — and the one string the whole OAuth
 * path has to agree on.
 *
 * Three URLs live here that look interchangeable and are not:
 *
 *   resource identifier   https://mcp.meetergo.com/mcp
 *   metadata document     https://mcp.meetergo.com/.well-known/oauth-protected-resource/mcp
 *   (also served at)      https://mcp.meetergo.com/.well-known/oauth-protected-resource
 *
 * The resource identifier is the URL a user types into their MCP client, and
 * the spec makes it the audience an access token is bound to. It MUST keep the
 * `/mcp` path and MUST match byte for byte in three places: the `resource`
 * field of the metadata document below, the `aud` claim we require on inbound
 * tokens (token-validation.ts), and the Audience mapper on the Keycloak `mcp`
 * client scope. Trim the path off any one of them and the audience check starts
 * comparing against a string no token will ever carry — every request 401s, and
 * the mismatch is invisible in both halves on their own.
 *
 * The metadata document is a well-known URI. RFC 9728 §3.1 makes the
 * PATH-INSERTED form canonical whenever the resource identifier has a path:
 * the identifier's path is spliced in after `/.well-known/…`. That matters
 * because a client MUST discard a document whose `resource` field does not
 * match the URL it fetched it from — and a document announcing
 * `…/mcp` served at the bare root form does not match. So the challenge
 * (`WWW-Authenticate: … resource_metadata=…`) advertises the path-inserted URL,
 * and the root form stays served only as compatibility for clients that probe
 * it (Anthropic's connector tries both). Same document either way; the resource
 * it describes does not change with the path a client happened to guess.
 */

/** Where the Streamable HTTP endpoint is mounted, and the tail of the resource identifier. */
export const MCP_ENDPOINT_PATH = '/mcp'

const WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource'

/** RFC 9728 §3.1 path-inserted form: the canonical location, the one advertised. */
const CANONICAL_METADATA_PATH = `${WELL_KNOWN_PATH}${MCP_ENDPOINT_PATH}`

/**
 * Canonical first, then the RFC 8615 root form, which is served purely so a
 * client that probes only there still discovers the authorization server.
 */
export const PROTECTED_RESOURCE_METADATA_PATHS: readonly string[] = [
  CANONICAL_METADATA_PATH,
  WELL_KNOWN_PATH,
]

/**
 * Minimum OAuth scope requested by the 401 challenge.
 *
 * `openid` identifies this as an OpenID Connect authorization flow without
 * asking for any optional identity data or realm-wide scopes. Pinning the
 * request here is important: clients otherwise fall back to the authorization
 * server's realm-wide `scopes_supported`, which can include scopes that are not
 * assigned to the pre-registered MCP client and makes Keycloak reject the
 * authorization request with `invalid_scope`.
 *
 * Keycloak still applies the client's configured default scopes, including the
 * `mcp-audience` mapper that this server validates. Do not add meetergo
 * capability names here: unlike `openid`, those would claim a resource
 * authorization boundary that exchanged OAuth tokens do not currently enforce.
 */
export const OIDC_AUTHENTICATION_SCOPE = 'openid'

/**
 * This server deliberately advertises NO `scopes_supported` in its protected
 * resource metadata.
 *
 * The five names that look like they belong here (`scheduling`, `crm`, `mira`,
 * `forms`, `account`) are Personal-Access-Token capabilities, enforced only in
 * the api's `AuthGuard.handlePersonalAccessToken`. The JWT path an exchanged
 * OAuth token takes has no scope check at all, so naming them would describe a
 * boundary that does not exist — worse than describing none, because a reader
 * of the metadata document would believe it.
 *
 * It would also break the flow outright: Keycloak rejects an authorization
 * request naming a scope that is not assigned to the client, so an advertised
 * `scheduling` fails the FIRST redirect with invalid_scope. The 401 challenge
 * separately requests only {@link OIDC_AUTHENTICATION_SCOPE}; that is an
 * authentication protocol scope, not a meetergo capability.
 *
 * The full rationale, and the condition for changing this, lives next to the
 * realm definition in infra/keycloak/realm/clients.tf. Add scopes here only in
 * the same change that teaches the api to enforce them for exchanged tokens.
 */

export interface ResourceIdentity {
  /** Canonical MCP endpoint URL: the `resource` field and the required token audience. */
  resource: string
  /** Canonical metadata URL, path-inserted — where `WWW-Authenticate` sends a client. */
  metadataUrl: string
}

/**
 * Derive both URLs from whatever MCP_PUBLIC_URL was set to.
 *
 * Only the origin of the input is used. That is deliberate: it makes
 * `https://mcp.meetergo.com`, `https://mcp.meetergo.com/` and
 * `https://mcp.meetergo.com/mcp` all produce the same canonical pair, instead
 * of the last one yielding a `/mcp/mcp` resource nobody can mint tokens for.
 */
export function resolveResourceIdentity(publicUrl: string): ResourceIdentity {
  let origin: string
  try {
    const url = new URL(publicUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported scheme ${url.protocol}`)
    }
    origin = url.origin
  } catch (error) {
    // Fail at startup: a bad public URL means every token audience is wrong,
    // which only shows up as a blanket 401 once real users try to connect.
    throw new Error(
      `MCP_PUBLIC_URL must be an absolute http(s) URL, got "${publicUrl}" (${String(error)})`,
    )
  }

  return {
    resource: `${origin}${MCP_ENDPOINT_PATH}`,
    metadataUrl: `${origin}${CANONICAL_METADATA_PATH}`,
  }
}

/** The RFC 9728 document served at {@link PROTECTED_RESOURCE_METADATA_PATHS}. */
export function protectedResourceMetadata(
  resource: string,
  issuer: string,
): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://developer.meetergo.com/mcp-server',
  }
}
