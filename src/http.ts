#!/usr/bin/env node
/**
 * meetergo hosted MCP — the same tools over Streamable HTTP.
 *
 * The stdio entry serves people who edit JSON config; this serves everyone who
 * clicks "connect": ChatGPT apps and claude.ai connectors require a remote
 * server, and both reach it here.
 *
 * This file is only the environment and the socket. Request handling lives in
 * http-app.ts, credential handling in oauth-gateway.ts.
 *
 * Accepted credentials, decided per request from the credential's own prefix:
 *   - Personal Access Token (`rgo-…`) — acts as its owner
 *   - Platform API Key (`ak_live:…`) + `x-meetergo-api-user-id` header
 *   - a Keycloak OAuth access token, which is validated as issued for THIS
 *     server and then exchanged for one the api accepts
 *
 * The first two are meetergo's own credentials, verified by the api itself, and
 * are forwarded untouched. EVERYTHING else — OAuth token or not — takes the
 * third path, which only exists when OAUTH_ISSUER, OAUTH_CLIENT_ID and
 * OAUTH_CLIENT_SECRET are ALL set: validate-then-exchange is not optional, so a
 * deployment that cannot do both offers no OAuth at all and refuses anything
 * that is not one of the first two outright.
 */
import { createServer } from 'node:http'
import { DEFAULT_BASE_URL } from './client.js'
import { logDiagnostic } from './diagnostics.js'
import { createRequestListener } from './http-app.js'
import { createOAuthGateway } from './oauth-gateway.js'
import { resolveResourceIdentity } from './oauth-metadata.js'
import { VERSION } from './version.js'

const PORT = Number(process.env.PORT ?? 8080)
const BASE_URL = process.env.MEETERGO_API_URL ?? DEFAULT_BASE_URL
const NEXT_URL = process.env.MEETERGO_NEXT_URL?.trim() || undefined
const DASHBOARD_URL = process.env.MEETERGO_DASHBOARD_URL?.trim() || undefined
/**
 * RESOURCE_URL is the canonical endpoint (…/mcp) that tokens are bound to;
 * RESOURCE_METADATA_URL is the well-known document that describes it. Different
 * URLs, different jobs — see oauth-metadata.ts before touching either.
 */
const { resource: RESOURCE_URL, metadataUrl: RESOURCE_METADATA_URL } =
  resolveResourceIdentity(
    process.env.MCP_PUBLIC_URL?.trim() || `http://localhost:${PORT}`,
  )
/**
 * OAuth is all three variables or none. OAUTH_ISSUER alone used to enable
 * validation while leaving the exchange off, which forwarded the client's own
 * token to the api — see oauth-gateway.ts.
 *
 * OAUTH_ISSUER is the Keycloak realm issuer, e.g.
 * https://login.meetergo.com/realms/meetergo. It is checked here at boot the
 * way MCP_PUBLIC_URL is: a malformed or plaintext-http one throws before the
 * socket is bound rather than 502ing every OAuth request.
 */
const oauth = createOAuthGateway({
  issuer: process.env.OAUTH_ISSUER?.trim(),
  clientId: process.env.OAUTH_CLIENT_ID?.trim(),
  clientSecret: process.env.OAUTH_CLIENT_SECRET?.trim(),
  audience: RESOURCE_URL,
})

/**
 * Deploy identity, baked into the image by apps/mcp-server/Dockerfile. Empty
 * outside a built image (local `node dist/http.js`), where the git tag and
 * commit are not a meaningful answer — hence the undefined rather than a
 * placeholder, so /healthz omits the block entirely instead of reporting "dev".
 */
const deploy = [
  ['version', process.env.APP_VERSION],
  ['revision', process.env.APP_REVISION],
  ['builtAt', process.env.APP_BUILT_AT],
].reduce<Record<string, string>>((acc, [key, value]) => {
  const trimmed = value?.trim()
  if (key && trimmed) acc[key] = trimmed
  return acc
}, {})

const httpServer = createServer(
  createRequestListener({
    version: VERSION,
    deploy: Object.keys(deploy).length > 0 ? deploy : undefined,
    baseUrl: BASE_URL,
    nextUrl: NEXT_URL,
    dashboardUrl: DASHBOARD_URL,
    resource: RESOURCE_URL,
    metadataUrl: RESOURCE_METADATA_URL,
    oauth,
  }),
)

httpServer.listen(PORT, () => {
  // The resource identifier is printed because a wrong one is otherwise silent:
  // it fails as a blanket 401 on every OAuth request, with nothing saying why.
  logDiagnostic('info', 'listening', {
    port: PORT,
    version: VERSION,
    api: BASE_URL,
    resource: RESOURCE_URL,
    resourceMetadata: RESOURCE_METADATA_URL,
    oauthIssuer: oauth?.issuer ?? null,
  })
})
