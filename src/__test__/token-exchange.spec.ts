import { TokenExchangeError, TokenExchanger } from '../token-exchange.js'

/** A fetch stand-in that replays a queue of responses and records the requests. */
function stubFetch(responses: Array<Response | Error>): {
  calls: Array<{ url: string; body: URLSearchParams }>
  restore: () => void
} {
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  const original = globalThis.fetch
  let index = 0

  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init.body)),
    })
    const next = responses[Math.min(index++, responses.length - 1)]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }) as unknown as typeof fetch

  return { calls, restore: () => void (globalThis.fetch = original) }
}

/** Build an unsigned JWT with the given `exp`; only the payload is ever read. */
function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

const exchanger = () =>
  new TokenExchanger({
    issuer: 'https://login.meetergo.com/realms/meetergo',
    clientId: 'mcp',
    clientSecret: 'shh',
  })

describe('TokenExchanger', () => {
  it('exchanges a subject token for one minted for this client', async () => {
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ access_token: jwt(300) }), { status: 200 }),
    ])
    try {
      const result = await exchanger().exchange('a.b.c')

      expect(result).toMatch(/^header\./)
      const { url, body } = fetchStub.calls[0]
      expect(url).toBe(
        'https://login.meetergo.com/realms/meetergo/protocol/openid-connect/token',
      )
      expect(body.get('grant_type')).toBe(
        'urn:ietf:params:oauth:grant-type:token-exchange',
      )
      expect(body.get('subject_token')).toBe('a.b.c')
      expect(body.get('client_id')).toBe('mcp')
    } finally {
      fetchStub.restore()
    }
  })

  it('reuses a cached exchange rather than hitting Keycloak per tool call', async () => {
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ access_token: jwt(300) }), { status: 200 }),
    ])
    try {
      const subject = exchanger()
      await subject.exchange('a.b.c')
      await subject.exchange('a.b.c')

      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('coalesces parallel calls on one credential into a single round-trip', async () => {
    // An agent fires its tool calls at once and this server is stateless, so
    // the whole burst arrives before any of it can populate the cache.
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ access_token: jwt(300) }), { status: 200 }),
      new Response(JSON.stringify({ access_token: jwt(300) }), { status: 200 }),
    ])
    try {
      const subject = exchanger()
      const [first, second] = await Promise.all([
        subject.exchange('a.b.c'),
        subject.exchange('a.b.c'),
      ])

      expect(fetchStub.calls).toHaveLength(1)
      expect(first).toBe(second)
    } finally {
      fetchStub.restore()
    }
  })

  it('trusts expires_in over the claims of the exchanged token', async () => {
    // RFC 6749 makes expires_in the authoritative lifetime; the `exp` claim is
    // only a fallback for a realm that omits it.
    const fetchStub = stubFetch([
      new Response(
        JSON.stringify({ access_token: 'opaque.to.us', expires_in: 300 }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ access_token: 'opaque.to.us', expires_in: 300 }),
        { status: 200 },
      ),
    ])
    try {
      const subject = exchanger()
      await subject.exchange('a.b.c')
      await subject.exchange('a.b.c')

      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('does not cache a token that is already at its expiry', async () => {
    // Two distinct Responses: a body can only be consumed once, so replaying
    // one object would fail for a reason unrelated to what this asserts.
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ access_token: jwt(5) }), { status: 200 }),
      new Response(JSON.stringify({ access_token: jwt(5) }), { status: 200 }),
    ])
    try {
      const subject = exchanger()
      await subject.exchange('a.b.c')
      await subject.exchange('a.b.c')

      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })

  // A rejected token means the user must re-authorize; surfacing it as 401
  // is what makes an MCP client re-run the OAuth flow instead of retrying.
  it('maps a Keycloak rejection to 401', async () => {
    const fetchStub = stubFetch([
      new Response('{"error":"invalid_token"}', { status: 400 }),
    ])
    try {
      await expect(exchanger().exchange('a.b.c')).rejects.toMatchObject({
        status: 401,
      })
    } finally {
      fetchStub.restore()
    }
  })

  // Re-authorizing the user cannot fix our client secret or the realm's
  // exchange policy. A 401 here would loop the client through the OAuth flow
  // forever against a deployment that is simply misconfigured.
  it('maps a refusal of OUR credentials to 502, not to "re-authorize"', async () => {
    for (const code of ['invalid_client', 'unauthorized_client']) {
      const fetchStub = stubFetch([
        new Response(JSON.stringify({ error: code }), { status: 401 }),
      ])
      try {
        await expect(exchanger().exchange('a.b.c')).rejects.toMatchObject({
          status: 502,
        })
      } finally {
        fetchStub.restore()
      }
    }
  })

  it('still maps a spent user token to 401', async () => {
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ])
    try {
      await expect(exchanger().exchange('a.b.c')).rejects.toMatchObject({
        status: 401,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('reports an unreachable Keycloak as 502 rather than leaking a raw error', async () => {
    const fetchStub = stubFetch([new Error('ECONNREFUSED')])
    try {
      await expect(exchanger().exchange('a.b.c')).rejects.toBeInstanceOf(
        TokenExchangeError,
      )
      await expect(exchanger().exchange('a.b.c')).rejects.toMatchObject({
        status: 502,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('maps an upstream failure to 502 rather than a bare throw', async () => {
    const fetchStub = stubFetch([new Response('boom', { status: 500 })])
    try {
      await expect(exchanger().exchange('a.b.c')).rejects.toBeInstanceOf(
        TokenExchangeError,
      )
      await expect(exchanger().exchange('a.b.c')).rejects.toMatchObject({
        status: 502,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('fails when Keycloak returns no access_token', async () => {
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ scope: 'openid' }), { status: 200 }),
    ])
    try {
      await expect(exchanger().exchange('a.b.c')).rejects.toBeInstanceOf(
        TokenExchangeError,
      )
    } finally {
      fetchStub.restore()
    }
  })
})
