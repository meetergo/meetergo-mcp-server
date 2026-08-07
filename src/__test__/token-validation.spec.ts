import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { isMeetergoCredential, isPlatformApiKey } from '../client.js'
import { TokenValidator } from '../token-validation.js'

const ISSUER = 'https://login.meetergo.com/realms/meetergo'
const RESOURCE = 'https://mcp.meetergo.com/mcp'

const realm = generateKeyPairSync('rsa', { modulusLength: 2048 })
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })

function jwk(
  key: KeyObject,
  kid: string,
  extra: Record<string, string> = {},
): Record<string, unknown> {
  return {
    ...key.export({ format: 'jwk' }),
    kid,
    use: 'sig',
    alg: 'RS256',
    ...extra,
  }
}

const REALM_JWKS = { keys: [jwk(realm.publicKey, 'sig-1')] }

const jwksResponse = (body: unknown = REALM_JWKS) =>
  new Response(JSON.stringify(body), { status: 200 })

/** A fetch stand-in that replays a queue of responses and records the requests. */
function stubFetch(responses: Array<Response | Error>): {
  calls: string[]
  restore: () => void
} {
  const calls: string[] = []
  const original = globalThis.fetch
  let index = 0

  globalThis.fetch = ((url: string) => {
    calls.push(String(url))
    const next = responses[Math.min(index++, responses.length - 1)]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }) as unknown as typeof fetch

  return { calls, restore: () => void (globalThis.fetch = original) }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** A realm-shaped access token, signed for real so the signature check is exercised. */
function token(
  claims: Record<string, unknown> = {},
  options: {
    alg?: string
    kid?: string
    key?: KeyObject
    signature?: string
  } = {},
): string {
  const header = b64({
    alg: options.alg ?? 'RS256',
    kid: options.kid ?? 'sig-1',
    typ: 'JWT',
  })
  const payload = b64({
    iss: ISSUER,
    aud: [RESOURCE, 'account'],
    sub: 'user-1',
    typ: 'Bearer',
    azp: 'mcp-client',
    exp: nowSeconds() + 300,
    ...claims,
  })
  const signature =
    options.signature ??
    sign(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      options.key ?? realm.privateKey,
    ).toString('base64url')
  return `${header}.${payload}.${signature}`
}

const validator = () =>
  new TokenValidator({ issuer: ISSUER, audience: RESOURCE })

describe('TokenValidator', () => {
  it('accepts a token the realm minted for this server', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(validator().validate(token())).resolves.toMatchObject({
        sub: 'user-1',
        azp: 'mcp-client',
      })
      expect(fetchStub.calls[0]).toBe(
        'https://login.meetergo.com/realms/meetergo/protocol/openid-connect/certs',
      )
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a single-string audience, which is what Keycloak emits for one', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({ aud: RESOURCE })),
      ).resolves.toMatchObject({ sub: 'user-1' })
    } finally {
      fetchStub.restore()
    }
  })

  // The MUST this module exists for. Without it the confidential client turns
  // any realm token into one the api accepts.
  it('rejects a token minted for a different resource', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({ aud: ['other-service', 'account'] })),
      ).rejects.toMatchObject({ status: 401 })
    } finally {
      fetchStub.restore()
    }
  })

  // The exact failure the canonical-URL fix prevents: the audience mapper emits
  // the endpoint URL, so a `resource` of the bare origin matches nothing.
  it('rejects an audience that is the origin without the /mcp path', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({ aud: 'https://mcp.meetergo.com' })),
      ).rejects.toThrow(/does not include https:\/\/mcp\.meetergo\.com\/mcp/)
    } finally {
      fetchStub.restore()
    }
  })

  it('rejects a token from another issuer', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({ iss: 'https://evil.example/realms/x' })),
      ).rejects.toThrow(/is not https:\/\/login\.meetergo\.com/)
    } finally {
      fetchStub.restore()
    }
  })

  it('rejects an expired token', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({ exp: nowSeconds() - 120 })),
      ).rejects.toThrow(/expired/)
    } finally {
      fetchStub.restore()
    }
  })

  it('rejects an ID token presented as a credential', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({ typ: 'ID' })),
      ).rejects.toThrow(/not an access token/)
    } finally {
      fetchStub.restore()
    }
  })

  it('rejects a token signed by a key the realm does not publish', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({}, { key: stranger.privateKey })),
      ).rejects.toThrow(/signature does not verify/)
    } finally {
      fetchStub.restore()
    }
  })

  it('answers 401, not a crash, for a garbage signature', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(
        validator().validate(token({}, { signature: 'not-a-signature' })),
      ).rejects.toMatchObject({ status: 401 })
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses a segment outside the base64url alphabet rather than transcoding it', async () => {
    // The signing input used to be taken with Node's 'ascii' encoding, which
    // truncates each code unit to a byte instead of rejecting it: 'A' (U+0041)
    // and 'Ł' (U+0141) become the same byte, so two different segment strings
    // can share one set of signed bytes. A JWS segment is base64url by
    // definition, so there is nothing legitimate to lose by refusing.
    const fetchStub = stubFetch([jwksResponse()])
    try {
      const [header, payload, signature] = token().split('.')
      for (const malformed of [
        `${header}.${payload}Ł.${signature}`,
        `${header}Ł.${payload}.${signature}`,
        `${header}.${payload}.${signature}=`,
      ]) {
        await expect(validator().validate(malformed)).rejects.toThrow(
          /not a JWT/,
        )
      }
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses any algorithm but RS256 before it looks up a key', async () => {
    // Algorithm confusion: `none` and HMAC-over-the-published-key both die here,
    // and the JWKS is never even fetched.
    const fetchStub = stubFetch([jwksResponse()])
    try {
      for (const alg of ['none', 'HS256']) {
        await expect(
          validator().validate(token({}, { alg, signature: 'not-checked' })),
        ).rejects.toThrow(/expected RS256/)
      }
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the realm encryption key when picking a signing key', async () => {
    // A Keycloak realm publishes its RSA-OAEP key alongside the signing one.
    // Verifying a signature with it must never happen.
    const fetchStub = stubFetch([
      jwksResponse({
        keys: [jwk(realm.publicKey, 'sig-1', { use: 'enc', alg: 'RSA-OAEP' })],
      }),
    ])
    try {
      await expect(validator().validate(token())).rejects.toMatchObject({
        status: 502,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('fetches the JWKS once, not once per request', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      const subject = validator()
      await subject.validate(token())
      await subject.validate(token())

      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports an unreachable realm as 502, never as a token problem', async () => {
    // A 401 here would send every client into an authorize loop over an outage
    // that re-authorizing cannot fix.
    const fetchStub = stubFetch([new Error('ECONNREFUSED')])
    try {
      await expect(validator().validate(token())).rejects.toMatchObject({
        status: 502,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('backs off instead of round-tripping the realm once per request during an outage', async () => {
    // A JWT-shaped request is free to send and free to make unique, so the
    // per-token rate limiter in http-app.ts bounds nothing here. Without a
    // failure backoff, every one of these opened another 5s wait on Keycloak.
    const clock = vi.spyOn(Date, 'now')
    const base = Date.now()
    clock.mockReturnValue(base)
    const fetchStub = stubFetch([new Error('ECONNREFUSED'), jwksResponse()])
    try {
      const subject = validator()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        clock.mockReturnValue(base + attempt * 1_000)
        await expect(subject.validate(token())).rejects.toMatchObject({
          status: 502,
        })
      }
      expect(fetchStub.calls).toHaveLength(1)

      // And it does try again afterwards: a realm that comes back must not need
      // a pod restart to be noticed.
      clock.mockReturnValue(base + 61_000)
      await expect(subject.validate(token())).resolves.toMatchObject({
        sub: 'user-1',
      })
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      clock.mockRestore()
      fetchStub.restore()
    }
  })

  it('keeps serving a cached key while the realm is unreachable', async () => {
    const clock = vi.spyOn(Date, 'now')
    const base = Date.now()
    clock.mockReturnValue(base)
    const longLived = token({ exp: Math.floor(base / 1000) + 3600 })
    const fetchStub = stubFetch([jwksResponse(), new Error('ECONNREFUSED')])
    try {
      const subject = validator()
      await subject.validate(longLived)

      // Past the cache TTL, so the next call tries to refresh and fails.
      clock.mockReturnValue(base + 11 * 60_000)
      await expect(subject.validate(longLived)).resolves.toMatchObject({
        sub: 'user-1',
      })
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      clock.mockRestore()
      fetchStub.restore()
    }
  })

  it('picks up a rotated key without refetching for every unknown kid', async () => {
    const clock = vi.spyOn(Date, 'now')
    const base = Date.now()
    clock.mockReturnValue(base)
    const fetchStub = stubFetch([
      jwksResponse(),
      jwksResponse({ keys: [jwk(realm.publicKey, 'sig-2')] }),
    ])
    try {
      const subject = validator()
      await subject.validate(token())

      // A stream of made-up kids must not become a stream of realm round-trips.
      await expect(
        subject.validate(token({}, { kid: 'sig-2' })),
      ).rejects.toThrow(/no signing key sig-2/)
      expect(fetchStub.calls).toHaveLength(1)

      clock.mockReturnValue(base + 31_000)
      await expect(
        subject.validate(token({}, { kid: 'sig-2' })),
      ).resolves.toMatchObject({ sub: 'user-1' })
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      clock.mockRestore()
      fetchStub.restore()
    }
  })
})

describe('credential routing', () => {
  // Validation and exchange are gated on isMeetergoCredential
  // (oauth-gateway.ts). meetergo's own credentials are verified by the api and
  // must reach it untouched — a Keycloak audience check would reject every one
  // of them.
  it('leaves meetergo credentials off the OAuth path', () => {
    expect(isMeetergoCredential('rgo-abc123')).toBe(true)
    expect(isMeetergoCredential('ak_live:uuid:secret')).toBe(true)
    expect(isPlatformApiKey('ak_live:uuid:secret')).toBe(true)
  })

  it('still refuses a non-JWT if one ever reaches the validator', async () => {
    const fetchStub = stubFetch([jwksResponse()])
    try {
      await expect(validator().validate('rgo-abc123')).rejects.toThrow(
        /not a JWT/,
      )
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
