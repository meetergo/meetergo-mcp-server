import {
  MCP_ENDPOINT_PATH,
  PROTECTED_RESOURCE_METADATA_PATHS,
  protectedResourceMetadata,
  resolveResourceIdentity,
} from '../oauth-metadata.js'

const ISSUER = 'https://login.meetergo.com/realms/meetergo'
const CANONICAL = 'https://mcp.meetergo.com/mcp'

describe('resolveResourceIdentity', () => {
  // The bug this replaces: the resource was the bare origin, so a token bound
  // to the URL the user actually typed never matched it.
  it('identifies the resource by the endpoint URL, path included', () => {
    expect(resolveResourceIdentity('https://mcp.meetergo.com').resource).toBe(
      CANONICAL,
    )
  })

  // RFC 9728 §3.1: with a path on the resource identifier, the canonical
  // metadata URL splices that path in after the well-known prefix. A client
  // MUST discard a document whose `resource` does not match where it was
  // fetched from, so advertising the root form pairs a document with a URL it
  // does not describe.
  it('advertises the path-inserted metadata URL, not the root one', () => {
    const { metadataUrl } = resolveResourceIdentity('https://mcp.meetergo.com')
    expect(metadataUrl).toBe(
      'https://mcp.meetergo.com/.well-known/oauth-protected-resource/mcp',
    )
  })

  it('advertises a metadata URL this server actually serves', () => {
    // The pairing the review found broken: the challenge named one URL and the
    // routing table answered at others.
    const { metadataUrl } = resolveResourceIdentity('https://mcp.meetergo.com')
    expect(PROTECTED_RESOURCE_METADATA_PATHS).toContain(
      new URL(metadataUrl).pathname,
    )
  })

  it('normalizes whatever shape MCP_PUBLIC_URL was set to', () => {
    // Notably the already-suffixed form: naive concatenation gives /mcp/mcp,
    // an identifier no Keycloak audience mapper will ever emit.
    for (const input of [
      'https://mcp.meetergo.com',
      'https://mcp.meetergo.com/',
      'https://mcp.meetergo.com///',
      'https://mcp.meetergo.com/mcp',
      'https://mcp.meetergo.com/mcp/',
    ]) {
      expect(resolveResourceIdentity(input).resource).toBe(CANONICAL)
    }
  })

  it('keeps a non-default port, which local and preview hosts need', () => {
    expect(resolveResourceIdentity('http://localhost:8080').resource).toBe(
      'http://localhost:8080/mcp',
    )
  })

  it('refuses a value that is not an absolute http(s) URL', () => {
    // Startup is the only place this is diagnosable; later it is a blanket 401.
    expect(() => resolveResourceIdentity('mcp.meetergo.com')).toThrow(
      /MCP_PUBLIC_URL/,
    )
    expect(() => resolveResourceIdentity('ftp://mcp.meetergo.com')).toThrow(
      /MCP_PUBLIC_URL/,
    )
  })
})

describe('protected resource metadata', () => {
  it('serves the canonical path-inserted URI and the root one', () => {
    // RFC 9728 §3.1 defines the canonical form; the root (RFC 8615) stays
    // served because clients in the wild probe it.
    expect(PROTECTED_RESOURCE_METADATA_PATHS).toEqual([
      `/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}`,
      '/.well-known/oauth-protected-resource',
    ])
  })

  it('announces the canonical resource and the realm that mints its tokens', () => {
    const { resource } = resolveResourceIdentity('https://mcp.meetergo.com')
    expect(protectedResourceMetadata(resource, ISSUER)).toMatchObject({
      resource: CANONICAL,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    })
  })

  it('advertises no scopes, because it enforces none', () => {
    // Two independent reasons, either one sufficient:
    //
    // 1. An exchanged OAuth token takes the api's JWT path, which has no scope
    //    check at all — only Personal Access Tokens are scope-enforced. Naming
    //    `scheduling`/`crm`/… here would describe a boundary that does not
    //    exist, which is worse than describing none.
    // 2. Keycloak rejects an authorization request naming a scope that is not
    //    assigned to the client, so advertising one breaks the FIRST redirect
    //    with invalid_scope.
    //
    // Add scopes only in the change that teaches the api to enforce them for
    // exchanged tokens. See infra/keycloak/realm/clients.tf.
    const { resource } = resolveResourceIdentity('https://mcp.meetergo.com')
    const document = protectedResourceMetadata(resource, ISSUER)

    expect(document).not.toHaveProperty('scopes_supported')
  })
})
