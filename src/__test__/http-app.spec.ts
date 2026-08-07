import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequestListener, type McpAppConfig } from '../http-app.js'
import type { OAuthSupport } from '../oauth-gateway.js'
import { TokenValidationError } from '../token-validation.js'

const RESOURCE = 'https://mcp.meetergo.com/mcp'
const METADATA_URL =
  'https://mcp.meetergo.com/.well-known/oauth-protected-resource/mcp'
const ISSUER = 'https://login.meetergo.com/realms/meetergo'
const API_URL = 'https://api.test/v4'
const EXCHANGED = 'exchanged-for-the-mcp-client'
/** Shaped like a JWT — three non-empty segments — which is all the routing looks at. */
const CLIENT_JWT = 'header.payload.signature'

/** An OAuth path that always succeeds, so tests can watch what reaches the api. */
const workingOAuth: OAuthSupport = {
  issuer: ISSUER,
  credentialFor: () => Promise.resolve(EXCHANGED),
}

interface Upstream {
  /** Every non-local request the process made, with the credential it carried. */
  calls: { url: string; authorization?: string }[]
  restore: () => void
}

/**
 * Intercept outbound fetch — the api and, in production, the realm — while
 * letting the test's own requests to the server under test through.
 */
function stubUpstream(): Upstream {
  const calls: Upstream['calls'] = []
  const original = globalThis.fetch

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('127.0.0.1')) return original(input as never, init)
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') ?? undefined })
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'user-1', email: 'a@b.c' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as unknown as typeof fetch

  return { calls, restore: () => void (globalThis.fetch = original) }
}

/** Run one block against a live server on an ephemeral port. */
async function withServer(
  overrides: Partial<McpAppConfig>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(
    createRequestListener({
      version: '9.9.9',
      baseUrl: API_URL,
      resource: RESOURCE,
      metadataUrl: METADATA_URL,
      ...overrides,
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

/** A credential path that always fails, so tests can watch what a refusal says. */
function failingOAuth(error: Error): OAuthSupport {
  return { issuer: ISSUER, credentialFor: () => Promise.reject(error) }
}

/** Capture the structured stderr lines a block emits. */
async function captureDiagnostics(
  run: () => Promise<unknown>,
): Promise<string> {
  const lines: string[] = []
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return lines.join('')
}

/** A tools/call the stateless transport answers without a prior handshake. */
function toolCall(token: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_me', arguments: {} },
    }),
  }
}

describe('the transport is mounted at /mcp only', () => {
  it('answers /mcp', async () => {
    const upstream = stubUpstream()
    try {
      await withServer({}, async (base) => {
        const response = await fetch(`${base}/mcp`, toolCall('rgo-abc123'))
        expect(response.status).toBe(200)
      })
    } finally {
      upstream.restore()
    }
  })

  // `/` used to serve the transport too, which gave users a URL they could
  // connect to but never authorize against: its resource identifier would be
  // the bare origin, which no token names.
  it('does not serve the transport at the root, and says where it is', async () => {
    const upstream = stubUpstream()
    try {
      await withServer({}, async (base) => {
        const response = await fetch(base, toolCall('rgo-abc123'))
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({
          detail: expect.stringContaining(RESOURCE),
        })
        expect(upstream.calls).toEqual([])
      })
    } finally {
      upstream.restore()
    }
  })

  it('reports its version on /healthz', async () => {
    await withServer({}, async (base) => {
      await expect(
        fetch(`${base}/healthz`).then((response) => response.json()),
      ).resolves.toEqual({ ok: true, version: '9.9.9' })
    })
  })

  // The package version and the deployed image tag come from different series
  // (npm vs the mcp-server-X.Y.Z git tags), so a pod has to report both or an
  // operator cannot map it back to a commit.
  it('reports deploy identity on /healthz when the image supplied it', async () => {
    const deploy = { version: '0.6.1', revision: 'abc1234', builtAt: '2026-08-06' }
    await withServer({ deploy }, async (base) => {
      await expect(
        fetch(`${base}/healthz`).then((response) => response.json()),
      ).resolves.toEqual({ ok: true, version: '9.9.9', deploy })
    })
  })

  it('omits the deploy block outside a built image', async () => {
    await withServer({}, async (base) => {
      const body = await fetch(`${base}/healthz`).then((r) => r.json())
      expect(body).not.toHaveProperty('deploy')
    })
  })
})

describe('credentials reaching the api', () => {
  it('forwards a Personal Access Token untouched', async () => {
    const upstream = stubUpstream()
    try {
      await withServer({ oauth: workingOAuth }, async (base) => {
        await fetch(`${base}/mcp`, toolCall('rgo-abc123'))
        expect(upstream.calls).toEqual([
          { url: `${API_URL}/user/me`, authorization: 'Bearer rgo-abc123' },
        ])
      })
    } finally {
      upstream.restore()
    }
  })

  it('sends the exchanged token upstream, never the one the client presented', async () => {
    const upstream = stubUpstream()
    try {
      await withServer({ oauth: workingOAuth }, async (base) => {
        await fetch(`${base}/mcp`, toolCall(CLIENT_JWT))

        expect(upstream.calls).toHaveLength(1)
        expect(upstream.calls[0].authorization).toBe(`Bearer ${EXCHANGED}`)
        expect(upstream.calls[0].authorization).not.toContain(CLIENT_JWT)
      })
    } finally {
      upstream.restore()
    }
  })

  // The blocker this suite exists for: with OAuth unconfigured the old code
  // forwarded the client's own JWT to the api — passthrough, which the MCP
  // spec forbids outright, in the chart's default state.
  it('refuses an OAuth token outright when OAuth is not configured', async () => {
    const upstream = stubUpstream()
    try {
      await withServer({}, async (base) => {
        const response = await fetch(`${base}/mcp`, toolCall(CLIENT_JWT))

        expect(response.status).toBe(401)
        expect(upstream.calls).toEqual([])
        expect(await response.json()).toMatchObject({
          detail: expect.stringContaining('Personal Access Token'),
        })
      })
    } finally {
      upstream.restore()
    }
  })

  // Same blocker, one shape further out: the discriminator used to be "not
  // three non-empty segments, therefore a meetergo credential", so a compact
  // JWE and friends reached the api exactly as the caller sent them.
  it('refuses a credential that is neither ours nor a JWT, rather than forwarding it', async () => {
    const upstream = stubUpstream()
    try {
      await withServer({}, async (base) => {
        for (const token of ['a.b.c.d.e', 'a.b.c.d', 'a..c', 'opaque-token']) {
          const response = await fetch(`${base}/mcp`, toolCall(token))
          expect(response.status).toBe(401)
        }
        expect(upstream.calls).toEqual([])
      })
    } finally {
      upstream.restore()
    }
  })
})

describe('what a refusal gives back to a stranger', () => {
  it('bounds a reason quoted out of a token, in the body as well as the header', async () => {
    // The reason names claim values from a token nobody has verified. The
    // 200-char bound used to apply to the LOG line only, so a token stuffed
    // with junk claims came back in full, quotes and all.
    const junk = `\u0007"quoted"\\back\u2028${'A'.repeat(4_000)}`
    await withServer(
      { oauth: failingOAuth(new TokenValidationError(junk, 401)) },
      async (base) => {
        const response = await fetch(`${base}/mcp`, toolCall(CLIENT_JWT))
        const body = (await response.json()) as { detail: string }
        const challenge = response.headers.get('www-authenticate') ?? ''

        expect(response.status).toBe(401)
        expect(body.detail.length).toBeLessThanOrEqual(200)
        expect(body.detail).not.toContain('\u0007')
        expect(body.detail).not.toContain('"')
        expect(body.detail).not.toContain('\\')
        // One escape feeding both, so the two cannot drift apart again.
        expect(challenge).toContain(`error_description="${body.detail}"`)
        expect(challenge.length).toBeLessThan(600)
      },
    )
  })

  it('keeps infrastructure detail in the log and out of a 502 body', async () => {
    const detail =
      'Could not reach the realm JWKS at http://keycloak.meetergo.svc.cluster.local:8080/realms/meetergo/protocol/openid-connect/certs: ECONNREFUSED'
    await withServer(
      { oauth: failingOAuth(new TokenValidationError(detail, 502)) },
      async (base) => {
        let body = ''
        const logged = await captureDiagnostics(async () => {
          body = await fetch(`${base}/mcp`, toolCall(CLIENT_JWT)).then(
            (response) => {
              expect(response.status).toBe(502)
              return response.text()
            },
          )
        })

        expect(body).not.toContain('cluster.local')
        expect(body).toContain('token_validation_failed')
        // The operator who can fix it still gets the whole thing.
        expect(logged).toContain('cluster.local')
      },
    )
  })
})

describe('the 401 challenge', () => {
  it('points at the canonical metadata document and names no scopes', async () => {
    await withServer({ oauth: workingOAuth }, async (base) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST' })
      const challenge = response.headers.get('www-authenticate') ?? ''

      expect(response.status).toBe(401)
      expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`)
      // Naming a scope the realm has not assigned to the client fails the
      // FIRST authorization redirect with invalid_scope.
      expect(challenge).not.toContain('scope=')
    })
  })

  it('offers no discovery when there is no authorization server to discover', async () => {
    // A resource_metadata pointing at a 404 sends the client round a flow that
    // cannot succeed.
    await withServer({}, async (base) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST' })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).not.toContain(
        'resource_metadata',
      )
    })
  })

  it('is readable by a browser-based client', async () => {
    // Without the expose header the browser gets the 401 with the challenge
    // stripped: it learns authorization failed but not where to authorize.
    await withServer({ oauth: workingOAuth }, async (base) => {
      const response = await fetch(`${base}/mcp`, { method: 'OPTIONS' })
      expect(response.headers.get('access-control-expose-headers')).toContain(
        'WWW-Authenticate',
      )
    })
  })
})

describe('protected resource metadata', () => {
  it('serves a document whose resource matches the canonical URL it is fetched from', async () => {
    await withServer({ oauth: workingOAuth }, async (base) => {
      const response = await fetch(`${base}${new URL(METADATA_URL).pathname}`)

      expect(response.status).toBe(200)
      const document = await response.json()
      expect(document).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
      })
      expect(document).not.toHaveProperty('scopes_supported')
    })
  })

  it('still answers the root well-known path clients probe', async () => {
    await withServer({ oauth: workingOAuth }, async (base) => {
      const response = await fetch(
        `${base}/.well-known/oauth-protected-resource`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ resource: RESOURCE })
    })
  })

  it('is absent on a deployment that offers no OAuth', async () => {
    await withServer({}, async (base) => {
      const response = await fetch(`${base}${new URL(METADATA_URL).pathname}`)
      expect(response.status).toBe(404)
    })
  })
})
