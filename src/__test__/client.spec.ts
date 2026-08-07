import {
  isPlatformApiKey,
  MeetergoApiError,
  MeetergoClient,
  MeetergoPlanLimitError,
  parseRetryAfter,
} from '../client.js'

/** A fetch stand-in that replays a queue of responses and records the requests. */
function stubFetch(
  responses: Array<Response | Error>,
): { calls: Array<{ url: URL; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const original = globalThis.fetch
  let index = 0

  globalThis.fetch = ((url: URL, init: RequestInit) => {
    calls.push({ url: new URL(String(url)), init })
    const next = responses[Math.min(index++, responses.length - 1)]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }) as unknown as typeof fetch

  return { calls, restore: () => void (globalThis.fetch = original) }
}

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200 })

function client(overrides: Partial<{ token: string; userId: string; baseUrl: string }> = {}) {
  return new MeetergoClient({ token: 'rgo-test', ...overrides })
}

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('2')).toBe(2000)
  })

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-04T09:00:00Z')
    expect(parseRetryAfter('Tue, 04 Aug 2026 09:00:03 GMT', now)).toBe(3000)
  })

  it('clamps a hostile value instead of parking the agent', () => {
    // A server answering "retry in an hour" must not freeze the tool call for
    // an hour — the host has no way to cancel it.
    expect(parseRetryAfter('3600')).toBe(20_000)
  })

  it('treats a past date as no delay, not a negative one', () => {
    const now = Date.parse('2026-08-04T09:00:00Z')
    expect(parseRetryAfter('Tue, 04 Aug 2026 08:00:00 GMT', now)).toBe(0)
  })

  it('ignores absent or unparseable headers', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter('  ')).toBeNull()
  })
})

describe('MeetergoClient', () => {
  it('sends auth, content type and an identifiable user agent', async () => {
    const { calls, restore } = stubFetch([ok()])
    try {
      await client({ userId: undefined }).request('GET', '/user/me')
    } finally {
      restore()
    }
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer rgo-test')
    expect(headers['User-Agent']).toBe('meetergo-mcp')
    expect(headers).not.toHaveProperty('x-meetergo-api-user-id')
  })

  it('sends the impersonation header only when a userId is configured', async () => {
    const { calls, restore } = stubFetch([ok()])
    try {
      await client({ userId: 'user-1' }).request('GET', '/user/me')
    } finally {
      restore()
    }
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-meetergo-api-user-id']).toBe('user-1')
  })

  it('resolves root-mounted paths off the host, not the /v4 base', async () => {
    // /crm predates the v4 split. Appending it to the versioned base 404s.
    const { calls, restore } = stubFetch([ok(), ok()])
    try {
      const c = client()
      await c.request('GET', '/appointment/today')
      await c.request('GET', '/crm', { root: true })
    } finally {
      restore()
    }
    expect(calls[0].url.pathname).toBe('/v4/appointment/today')
    expect(calls[1].url.pathname).toBe('/crm')
  })

  it('strips only the trailing /v4 so a path-prefixed staging host still works', async () => {
    const { calls, restore } = stubFetch([ok()])
    try {
      await client({ baseUrl: 'https://staging.example.com/api/v4' }).request(
        'GET',
        '/crm',
        { root: true },
      )
    } finally {
      restore()
    }
    expect(calls[0].url.href).toBe('https://staging.example.com/api/crm')
  })

  it('repeats array query keys rather than joining them with commas', async () => {
    // @IsString({ each: true }) rejects "a,b" as a single value.
    const { calls, restore } = stubFetch([ok()])
    try {
      await client().request('GET', '/crm', {
        query: { tags: ['Lead', 'Enterprise'] },
        root: true,
      })
    } finally {
      restore()
    }
    expect(calls[0].url.searchParams.getAll('tags')).toEqual([
      'Lead',
      'Enterprise',
    ])
  })

  it('drops empty query values instead of sending them as blanks', async () => {
    const { calls, restore } = stubFetch([ok()])
    try {
      await client().request('GET', '/appointment/paginated', {
        query: { page: 0, search: undefined, status: '' },
      })
    } finally {
      restore()
    }
    // page 0 is meaningful and must survive; the other two must not appear.
    expect(calls[0].url.searchParams.get('page')).toBe('0')
    expect(calls[0].url.searchParams.has('search')).toBe(false)
    expect(calls[0].url.searchParams.has('status')).toBe(false)
  })

  it('retries a rate limit and returns the eventual success', async () => {
    const { calls, restore } = stubFetch([
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      ok({ result: [] }),
    ])
    try {
      const result = await client().request('GET', '/crm', { root: true })
      expect(result).toEqual({ result: [] })
    } finally {
      restore()
    }
    expect(calls).toHaveLength(2)
  })

  it('never repeats a mutation after an ambiguous failure', async () => {
    // The request may already have booked the meeting and sent the invitation;
    // only the response was lost. There is no idempotency key, so a retry here
    // books it twice.
    for (const failure of [
      new Error('socket hang up'),
      new Response('', { status: 503 }),
    ]) {
      const { calls, restore } = stubFetch([failure, ok()])
      try {
        await expect(client().request('POST', '/booking')).rejects.toThrow()
      } finally {
        restore()
      }
      expect(calls).toHaveLength(1)
    }
  })

  it('does retry a mutation the server refused outright', async () => {
    // 429 is the one status that promises the request was not processed.
    const { calls, restore } = stubFetch([
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      ok({ appointmentId: 'ap-1' }),
    ])
    try {
      await expect(client().request('POST', '/booking')).resolves.toEqual({
        appointmentId: 'ap-1',
      })
    } finally {
      restore()
    }
    expect(calls).toHaveLength(2)
  })

  it('retries a read whose body fails midway', async () => {
    // The body arrives after the headers and can stall on its own. A GET is
    // safe to repeat, so this should not surface as a failure.
    const broken = new Response('{}')
    Object.defineProperty(broken, 'text', {
      value: () => Promise.reject(new Error('ECONNRESET')),
    })
    const { calls, restore } = stubFetch([broken, ok({ ok: true })])
    try {
      await expect(client().request('GET', '/user/me')).resolves.toEqual({
        ok: true,
      })
    } finally {
      restore()
    }
    expect(calls).toHaveLength(2)
  })

  it('names the timeout budget instead of leaking "signal timed out"', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    })
    const { restore } = stubFetch([timeout])
    try {
      await expect(client().request('POST', '/booking')).rejects.toThrow(
        /timed out after 30000ms/,
      )
    } finally {
      restore()
    }
  })

  it('does not retry a client error', async () => {
    // A 400 is a real answer. Retrying it just burns the agent's turn.
    const { calls, restore } = stubFetch([
      new Response(JSON.stringify({ message: ['start must be ISO 8601'] }), {
        status: 400,
      }),
    ])
    try {
      await expect(
        client().request('GET', '/booking-availability'),
      ).rejects.toThrow(MeetergoApiError)
    } finally {
      restore()
    }
    expect(calls).toHaveLength(1)
  })

  it('surfaces the API validation message so the agent can correct itself', async () => {
    const { restore } = stubFetch([
      new Response(
        JSON.stringify({ message: ['attendee should not be empty'] }),
        { status: 400 },
      ),
    ])
    try {
      await expect(client().request('POST', '/booking')).rejects.toThrow(
        /attendee should not be empty/,
      )
    } finally {
      restore()
    }
  })

  it('gives up after the retry budget and reports the transport failure', async () => {
    const { calls, restore } = stubFetch([new Error('ECONNRESET')])
    try {
      await expect(client().request('GET', '/user/me')).rejects.toThrow(
        /ECONNRESET/,
      )
    } finally {
      restore()
    }
    expect(calls).toHaveLength(3)
  })

  it('treats 204 and an empty body as success, not a parse error', async () => {
    const { restore } = stubFetch([new Response(null, { status: 204 })])
    try {
      await expect(
        client().request('PATCH', '/appointment/ap-1/guest'),
      ).resolves.toBeUndefined()
    } finally {
      restore()
    }
  })
})

describe('plan limits', () => {
  it('turns PLAN_LIMIT_REACHED into a structured error with an upgrade door', async () => {
    const { restore } = stubFetch([
      new Response(
        JSON.stringify({
          message: 'Knowledge page limit reached',
          code: 'PLAN_LIMIT_REACHED',
          feature: 'knowledgePageLimit',
        }),
        { status: 403 },
      ),
    ])
    try {
      await expect(
        client().request('POST', '/knowledge/crawl', { root: true }),
      ).rejects.toThrow(MeetergoPlanLimitError)
    } finally {
      restore()
    }
  })

  it('names the limit, the upgrade URL, and the no-pitch rule in the message', async () => {
    const { restore } = stubFetch([
      new Response(
        JSON.stringify({ code: 'PLAN_LIMIT_REACHED', feature: 'seats' }),
        { status: 403 },
      ),
    ])
    try {
      await client().request('POST', '/x', { root: true })
      throw new Error('should have thrown')
    } catch (error) {
      const err = error as MeetergoPlanLimitError
      expect(err.feature).toBe('seats')
      expect(err.upgradeUrl).toContain('/admin/subscription?feature=seats')
      expect(err.upgradeUrl).toContain('utm_source=mcp')
      expect(err.message).toMatch(/do not turn it into a pitch/)
    } finally {
      restore()
    }
  })

  it('leaves ordinary errors untouched', async () => {
    const { restore } = stubFetch([
      new Response(JSON.stringify({ message: 'slot no longer available' }), {
        status: 409,
      }),
    ])
    try {
      await expect(client().request('POST', '/x')).rejects.toThrow(
        MeetergoApiError,
      )
      await expect(client().request('POST', '/x')).rejects.not.toThrow(
        MeetergoPlanLimitError,
      )
    } finally {
      restore()
    }
  })
})

describe('credential shape', () => {
  it('recognises a Platform API Key by its prefix', () => {
    expect(isPlatformApiKey('ak_live:uuid:secret')).toBe(true)
    // Drives both startup guards: a PAT may not carry MEETERGO_USER_ID (the API
    // rejects the header), and a Platform API Key must (the API demands an
    // acting user on every route that is not explicitly exempt).
    expect(isPlatformApiKey('rgo-abc123')).toBe(false)
  })
})
