/**
 * The hosted endpoint's request handling — everything except reading the
 * environment and binding a port, which is http.ts.
 *
 * Split out so the parts that were wrong before can be tested against a real
 * socket: which paths exist, what a 401 challenge says, and above all that no
 * request can put a client's own OAuth token in front of the api. A handler
 * that only exists inside `createServer` at module scope cannot be asserted on
 * without starting the whole process.
 *
 * Stateless by design — every request carries its own `Authorization: Bearer`
 * credential and gets a fresh per-request server bound to a client for exactly
 * that credential, so one pod serves any number of tenants and horizontal
 * scaling needs no session store.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isPlatformApiKey, MeetergoClient } from './client.js'
import { logDiagnostic, safeText } from './diagnostics.js'
import {
  OAuthNotSupportedError,
  resolveUpstreamToken,
  type OAuthSupport,
} from './oauth-gateway.js'
import {
  MCP_ENDPOINT_PATH,
  PROTECTED_RESOURCE_METADATA_PATHS,
  protectedResourceMetadata,
} from './oauth-metadata.js'
import { buildServer } from './server.js'
import { TokenExchangeError } from './token-exchange.js'
import { TokenValidationError } from './token-validation.js'

export interface McpAppConfig {
  /** The PACKAGE version, from package.json — shared with the npm build. */
  version: string
  /**
   * The DEPLOY's identity, baked into the image by the Dockerfile. Separate
   * from `version` on purpose: the image tag comes from the `mcp-server-X.Y.Z`
   * git tag series, which is not the npm version, so an operator asking "what
   * is this pod running" needs both. Absent outside a built image.
   */
  deploy?: { version?: string; revision?: string; builtAt?: string }
  /** meetergo API root the tools call. */
  baseUrl: string
  /** apps/next root, rendered into widget install snippets. */
  nextUrl?: string
  /** Dashboard root, rendered into upgrade links. */
  dashboardUrl?: string
  /** Canonical MCP endpoint URL — the RFC 9728 resource identifier. */
  resource: string
  /** Canonical (path-inserted) protected-resource metadata URL. */
  metadataUrl: string
  /**
   * Present only when OAuth is fully configured. Absent means this deployment
   * accepts meetergo's own credentials and nothing else — one flag for one
   * fact, so discovery and token handling can never disagree about it.
   */
  oauth?: OAuthSupport
  /**
   * Domain-verification token for the ChatGPT app directory, served verbatim at
   * /.well-known/openai-apps-challenge. OpenAI fetches it to prove we control
   * the host it is about to list.
   *
   * Not a credential: possessing the string grants nothing, because the proof
   * IS being able to serve it from this origin. It is configured rather than
   * hardcoded so a re-issued token is a values change, not a release.
   */
  openaiAppsChallengeToken?: string
}

/**
 * Per-credential fixed window. One pod's view only — the real budget also
 * exists in the API's own rate limits — but it stops a runaway agent loop
 * from hammering upstream through us.
 */
const RATE_LIMIT = 120
const RATE_WINDOW_MS = 60_000
/**
 * Ceiling on distinct keys the limiter will track. The limiter runs BEFORE
 * any token is validated, so the key space is attacker-chosen: without a cap,
 * rotating garbage tokens both dodges the per-token window and grows the map
 * until the 187 MB heap is gone. At the cap, unknown keys are simply refused —
 * callers already being tracked (every legitimate, repeating credential) keep
 * working through the flood.
 */
const RATE_MAX_KEYS = 10_000

/**
 * Requests larger than this never reach the JSON parse. The SDK's streamable
 * transport buffers the whole body with no limit of its own, and this pod runs
 * one replica with a 256 MB ceiling — without this check, one oversized POST
 * (sent with any Bearer string at all) is a denial of service. 1 MB is two
 * orders of magnitude above any real MCP request.
 */
const MAX_BODY_BYTES = 1_000_000

/** Where OpenAI looks to confirm we control this host before listing it. */
const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge'

function createRateLimiter(): (key: string) => boolean {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  // The map only grows while distinct keys keep arriving; sweep expired
  // windows so a scan of dead keys cannot become a slow leak.
  setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets)
      if (bucket.resetAt <= now) buckets.delete(key)
  }, RATE_WINDOW_MS).unref()

  return (key) => {
    const now = Date.now()
    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= RATE_MAX_KEYS) return true
      buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
      return false
    }
    bucket.count += 1
    return bucket.count > RATE_LIMIT
  }
}

/**
 * Rate-limit key for a credential nobody has validated yet: a digest, never
 * the token itself. Hashing keeps plaintext credentials out of a long-lived
 * map (a heap dump of the limiter must not be a token list), and makes the
 * key a fixed 32 bytes no matter what arrived in the header.
 */
function rateKey(token: string): string {
  return createHash('sha256').update(token).digest('base64')
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Meetergo-Api-User-Id',
  )
  // WWW-Authenticate is exposed because a browser-based MCP client otherwise
  // receives the 401 with the challenge stripped by CORS — it can see that
  // authorization failed but not where to authorize, which is the whole
  // content of the reply.
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Mcp-Session-Id, WWW-Authenticate',
  )
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const NO_CREDENTIAL_HINT =
  'Send Authorization: Bearer <token>. A Personal Access Token (rgo-…) from https://my.meetergo.com/integrations works on every plan.'

/**
 * Untrusted text on its way back out to the caller.
 *
 * A refusal reason quotes claim values lifted from a token a stranger sent us,
 * and it lands in two places: an RFC 6750 quoted-string in `WWW-Authenticate`,
 * and a JSON body. Both get the same treatment, from one function, because
 * keeping two escapes in step by hand is how the body ended up unbounded while
 * only the log was capped — a token carrying a megabyte of junk claims was
 * reflected back in full. {@link safeText} supplies the bound and drops control
 * characters; the rest is the header's rule applied to the body as well:
 * printable ASCII, minus the two characters that would end or escape the
 * quoted-string.
 */
function reflected(text: string): string {
  return safeText(text)
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/["\\]/g, '')
}

/**
 * RFC 6750 challenge. `resource_metadata` (RFC 9728) is what lets an
 * OAuth-capable host start the flow instead of dead-ending on a 401 — but only
 * when there is a flow to start, so it is absent on a deployment that offers no
 * OAuth. Note it points at the METADATA DOCUMENT, not at the `/mcp` resource
 * identifier that tokens are audience-bound to.
 */
function unauthorized(
  res: ServerResponse,
  config: McpAppConfig,
  reason?: string,
): void {
  const params: string[] = []
  // No `scope` parameter: this resource enforces no scopes, and naming one that
  // is not assigned to the client makes Keycloak fail the first redirect with
  // invalid_scope. See the header of oauth-metadata.ts.
  if (config.oauth) {
    params.push(`resource_metadata="${config.metadataUrl}"`)
  }
  const detail = reason ? reflected(reason) : undefined
  if (detail) {
    params.push('error="invalid_token"', `error_description="${detail}"`)
  }
  res.setHeader(
    'WWW-Authenticate',
    params.length ? `Bearer ${params.join(', ')}` : 'Bearer',
  )
  json(res, 401, { error: 'unauthorized', detail: detail ?? NO_CREDENTIAL_HINT })
}

/**
 * The 502 half of a credential failure: the realm is unreachable, or our own
 * client is not permitted to exchange.
 *
 * The message that says which one names internal hostnames and quotes
 * Keycloak's response body — infrastructure detail, handed to a caller who has
 * not authenticated and could act on none of it. So it goes to the log, where
 * the operator who can fix it is looking, and the reply carries the only part
 * that belongs to the caller: this is ours, not yours, try again.
 */
function upstreamUnavailable(
  res: ServerResponse,
  event: string,
  error: Error,
): void {
  logDiagnostic('warn', event, { reason: safeText(error) })
  json(res, 502, {
    error: event,
    detail: 'The authorization server is unavailable. Try again shortly.',
  })
}

/** Turn a credential failure into the reply that makes the client do the right thing. */
function refuseCredential(
  res: ServerResponse,
  config: McpAppConfig,
  error: unknown,
): void {
  if (error instanceof OAuthNotSupportedError) {
    // The one case with nothing to see in the request: it is the deployment
    // that is wrong, and without this line the symptom is users reporting that
    // "OAuth does not work" against a server that never claimed to offer it.
    logDiagnostic('warn', 'oauth_token_refused_not_configured', {
      hint: 'Set OAUTH_ISSUER, OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET to accept OAuth access tokens.',
    })
    return unauthorized(res, config, error.message)
  }
  if (error instanceof TokenValidationError) {
    // 502 is the realm being unreachable, which re-authorizing cannot fix; a
    // 401 there would loop the client through an authorize flow over an outage.
    if (error.status === 401) return unauthorized(res, config, error.message)
    return upstreamUnavailable(res, 'token_validation_failed', error)
  }
  if (error instanceof TokenExchangeError) {
    // 401 means the user's token is no longer good — say so in the shape that
    // makes an MCP client re-run the OAuth flow instead of retrying.
    if (error.status === 401)
      return unauthorized(
        res,
        config,
        'The authorization server would not exchange this token. Re-authorize and try again.',
      )
    return upstreamUnavailable(res, 'token_exchange_failed', error)
  }
  throw error
}

export function createRequestListener(config: McpAppConfig): RequestListener {
  const rateLimited = createRateLimiter()

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Reject oversized bodies before anything buffers them.
    //
    // A declared length is the cheap case: refuse it without reading a byte.
    // A chunked request declares nothing, and refusing those outright was
    // wrong — `Transfer-Encoding: chunked` is ordinary HTTP that plenty of
    // clients send, and a 411 there rejects legitimate traffic to close a
    // hole that can be closed without it. So the undeclared case is capped by
    // counting instead.
    //
    // The counter watches the SOCKET rather than the request stream: adding a
    // `data` listener to `req` would put it in flowing mode and race the SDK
    // transport for the body. `socket.bytesRead` is observational — the HTTP
    // parser stays the only consumer — and it counts headers too, which only
    // makes the ceiling slightly stricter than the body alone.
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json(res, 413, {
        error: 'payload_too_large',
        detail: `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`,
      })
    }
    if (!Number.isFinite(declaredLength) && req.method === 'POST') {
      const socket = req.socket
      const stopOversized = () => {
        if (socket.bytesRead > MAX_BODY_BYTES) socket.destroy()
      }
      socket.on('data', stopOversized)
      res.on('close', () => socket.off('data', stopOversized))
    }

    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined
    if (!token) return unauthorized(res, config)
    if (rateLimited(rateKey(token))) {
      res.setHeader('Retry-After', '60')
      return json(res, 429, { error: 'rate_limited', detail: 'Slow down.' })
    }

    const userIdHeader = req.headers['x-meetergo-api-user-id']
    const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader
    if (userId && !isPlatformApiKey(token)) {
      return json(res, 400, {
        error: 'invalid_request',
        detail:
          'x-meetergo-api-user-id only applies to Platform API Keys; a Personal Access Token always acts as its owner.',
      })
    }

    // The only place a credential is chosen. Everything below uses what came
    // back, never `token` — see resolveUpstreamToken for why that matters.
    let upstreamToken: string
    try {
      upstreamToken = await resolveUpstreamToken(token, config.oauth)
    } catch (error) {
      return refuseCredential(res, config, error)
    }

    const client = new MeetergoClient({
      token: upstreamToken,
      userId: userId || undefined,
      baseUrl: config.baseUrl,
      nextUrl: config.nextUrl,
      dashboardUrl: config.dashboardUrl,
      userAgent: `meetergo-mcp-http/${config.version}`,
    })
    const server = buildServer(client, config.version, { ui: true })
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session ids, no in-memory conversation state, any pod can
      // answer any request. The MCP session concept buys us nothing while every
      // request is independently authenticated.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  return (req, res) => {
    setCors(res)
    const path = (req.url ?? '/').split('?')[0]

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    if (path === '/healthz')
      return json(res, 200, {
        ok: true,
        version: config.version,
        ...(config.deploy && { deploy: config.deploy }),
      })
    // Plain text, no trailing newline: OpenAI compares the body byte for byte.
    if (path === OPENAI_APPS_CHALLENGE_PATH) {
      if (!config.openaiAppsChallengeToken) return json(res, 404, {
        error: 'not_configured',
        detail: 'No ChatGPT app-directory challenge token is configured.',
      })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(config.openaiAppsChallengeToken)
    }
    if (PROTECTED_RESOURCE_METADATA_PATHS.includes(path)) {
      if (!config.oauth)
        return json(res, 404, {
          error: 'oauth_not_configured',
          detail: 'This deployment accepts bearer tokens only.',
        })
      return json(
        res,
        200,
        protectedResourceMetadata(config.resource, config.oauth.issuer),
      )
    }
    if (path === MCP_ENDPOINT_PATH) {
      handleMcp(req, res).catch((error: unknown) => {
        // safeText, like every other line here: an error escaping this far can
        // still be carrying text a request put there. The reply says nothing
        // about it — a stack or an upstream URL is for the log, not the caller.
        logDiagnostic('error', 'request_failed', { reason: safeText(error) })
        if (!res.headersSent)
          json(res, 500, {
            error: 'internal',
            detail: 'The request could not be completed.',
          })
      })
      return
    }
    // Deliberately no transport at `/`. Its resource identifier would be the
    // bare origin, which is not what any token names, so a client that
    // connected there could never authorize — a URL that works until the moment
    // it matters. One endpoint, one identifier, named in the 404 so anyone who
    // guessed the root is told where to go.
    json(res, 404, {
      error: 'not_found',
      detail: `The MCP endpoint is ${config.resource}.`,
    })
  }
}
