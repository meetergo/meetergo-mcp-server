import { generateKeyPairSync, sign } from 'node:crypto'
import {
  createOAuthGateway,
  OAuthGateway,
  OAuthNotSupportedError,
  resolveUpstreamToken,
  type OAuthCredentialSource,
} from '../oauth-gateway.js'

const ISSUER = 'https://login.meetergo.com/realms/meetergo'
const RESOURCE = 'https://mcp.meetergo.com/mcp'
const JWKS_URL = `${ISSUER}/protocol/openid-connect/certs`
const TOKEN_URL = `${ISSUER}/protocol/openid-connect/token`

const realm = generateKeyPairSync('rsa', { modulusLength: 2048 })

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** A realm-shaped access token, signed for real so the signature check is exercised. */
function realmToken(claims: Record<string, unknown> = {}): string {
  const header = b64({ alg: 'RS256', kid: 'sig-1', typ: 'JWT' })
  const payload = b64({
    iss: ISSUER,
    aud: [RESOURCE],
    sub: 'user-1',
    typ: 'Bearer',
    azp: 'some-oauth-client',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    realm.privateKey,
  ).toString('base64url')
  return `${header}.${payload}.${signature}`
}

const EXCHANGED = 'exchanged.for.us'

/**
 * Stands in for the realm: the JWKS document and the token endpoint, recording
 * every URL so a test can assert an exchange did NOT happen.
 */
function stubRealm(
  options: { tokenResponse?: Response } = {},
): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const original = globalThis.fetch

  globalThis.fetch = ((url: string) => {
    calls.push(String(url))
    if (String(url) === JWKS_URL) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [
              {
                ...realm.publicKey.export({ format: 'jwk' }),
                kid: 'sig-1',
                use: 'sig',
                alg: 'RS256',
              },
            ],
          }),
          { status: 200 },
        ),
      )
    }
    return Promise.resolve(
      options.tokenResponse ??
        new Response(
          JSON.stringify({ access_token: EXCHANGED, expires_in: 300 }),
          { status: 200 },
        ),
    )
  }) as unknown as typeof fetch

  return { calls, restore: () => void (globalThis.fetch = original) }
}

/** Capture the structured stderr lines a block emits. */
async function captureDiagnostics(
  run: () => Promise<unknown>,
): Promise<Record<string, unknown>[]> {
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
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Credentials meetergo never issued. Every one of them was forwarded to the api
 * verbatim while the test that decided was a denylist of one token shape:
 * "three non-empty dot-separated segments" makes a compact JWE, a four-segment
 * token and `a..c` all "not a JWT, therefore ours".
 */
const NOT_OURS = [
  'a.b.c.d.e',
  'a.b.c.d',
  'a..c',
  '',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
]

describe('resolveUpstreamToken', () => {
  const gateway: OAuthCredentialSource = {
    credentialFor: () => Promise.resolve(EXCHANGED),
  }

  it('passes meetergo credentials through untouched', async () => {
    // PATs and Platform API Keys are verified by the api itself; validating
    // them against a realm would reject every one of them.
    for (const token of ['rgo-abc123', 'ak_live:uuid:secret']) {
      await expect(resolveUpstreamToken(token, gateway)).resolves.toBe(token)
      await expect(resolveUpstreamToken(token, undefined)).resolves.toBe(token)
    }
  })

  it('refuses anything that is not recognisably a meetergo credential', async () => {
    for (const token of NOT_OURS) {
      await expect(resolveUpstreamToken(token, undefined)).rejects.toBeInstanceOf(
        OAuthNotSupportedError,
      )
    }
  })

  it('sends everything else down validate-then-exchange, JWT-shaped or not', async () => {
    const presented: string[] = []
    const recording: OAuthCredentialSource = {
      credentialFor: (token) => {
        presented.push(token)
        return Promise.resolve(EXCHANGED)
      },
    }

    for (const token of NOT_OURS) {
      await expect(resolveUpstreamToken(token, recording)).resolves.toBe(
        EXCHANGED,
      )
    }
    // Nothing skipped the credential source on its way through.
    expect(presented).toEqual(NOT_OURS)
  })

  // THE regression test. A JWT reaching the api as itself is the passthrough
  // the MCP spec forbids outright, and it is what the previous code did
  // whenever the exchange was not configured.
  it('never returns the presented JWT, whatever the configuration', async () => {
    const jwt = realmToken()

    await expect(resolveUpstreamToken(jwt, gateway)).resolves.toBe(EXCHANGED)
    await expect(resolveUpstreamToken(jwt, gateway)).resolves.not.toBe(jwt)
    await expect(resolveUpstreamToken(jwt, undefined)).rejects.toBeInstanceOf(
      OAuthNotSupportedError,
    )
  })

  it('refuses an OAuth token with 401 when this deployment offers no OAuth', async () => {
    // Not 501/503: nothing is temporary or unfinished, the resource just does
    // not accept this credential — and the reply names one that works.
    await expect(
      resolveUpstreamToken(realmToken(), undefined),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('Personal Access Token'),
    })
  })

  it('propagates a gateway failure rather than falling back to the raw token', async () => {
    const failing: OAuthCredentialSource = {
      credentialFor: () => Promise.reject(new Error('nope')),
    }
    await expect(resolveUpstreamToken(realmToken(), failing)).rejects.toThrow(
      'nope',
    )
  })
})

describe('OAuthGateway', () => {
  const gateway = () =>
    new OAuthGateway({
      issuer: ISSUER,
      clientId: 'mcp',
      clientSecret: 'shh',
      audience: RESOURCE,
    })

  it('validates against the realm, then hands back the exchanged token', async () => {
    const realmStub = stubRealm()
    try {
      await expect(gateway().credentialFor(realmToken())).resolves.toBe(
        EXCHANGED,
      )
      expect(realmStub.calls).toEqual([JWKS_URL, TOKEN_URL])
    } finally {
      realmStub.restore()
    }
  })

  it('does not reach the exchange for a token minted for someone else', async () => {
    // Order is the whole guarantee: exchanging first would turn anything the
    // realm ever signed into a credential the api trusts.
    const realmStub = stubRealm()
    try {
      await expect(
        gateway().credentialFor(realmToken({ aud: ['some-other-service'] })),
      ).rejects.toMatchObject({ status: 401 })
      expect(realmStub.calls).not.toContain(TOKEN_URL)
    } finally {
      realmStub.restore()
    }
  })

  it('reports which check failed, with both sides of the comparison', async () => {
    const realmStub = stubRealm()
    try {
      const diagnostics = await captureDiagnostics(async () => {
        await gateway()
          .credentialFor(realmToken({ aud: ['some-other-service'] }))
          .catch(() => undefined)
      })

      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          event: 'oauth_token_rejected',
          expectedIssuer: ISSUER,
          expectedAudience: RESOURCE,
        }),
      )
    } finally {
      realmStub.restore()
    }
  })

  it('names the authorized party when the exchange itself is refused', async () => {
    const realmStub = stubRealm({
      tokenResponse: new Response('{"error":"unauthorized_client"}', {
        status: 401,
      }),
    })
    try {
      const jwt = realmToken()
      const diagnostics = await captureDiagnostics(async () => {
        await gateway().credentialFor(jwt).catch(() => undefined)
      })

      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          event: 'oauth_exchange_failed',
          subject: 'user-1',
          authorizedParty: 'some-oauth-client',
          exchangeClient: 'mcp',
        }),
      )
      // Diagnostics describe credentials, they never quote them.
      expect(JSON.stringify(diagnostics)).not.toContain(jwt)
      expect(JSON.stringify(diagnostics)).not.toContain('shh')
    } finally {
      realmStub.restore()
    }
  })
})

describe('createOAuthGateway', () => {
  it('builds a gateway only when every part is configured', () => {
    expect(
      createOAuthGateway({
        issuer: ISSUER,
        clientId: 'mcp',
        clientSecret: 'shh',
        audience: RESOURCE,
      }),
    ).toBeInstanceOf(OAuthGateway)
  })

  it('fails at boot on an issuer that is not a URL', () => {
    // Per request it would only ever surface as a 502 on the JWKS fetch, which
    // reads as an outage rather than as a typo in the deployment.
    expect(() =>
      createOAuthGateway({
        issuer: 'login.meetergo.com/realms/meetergo',
        clientId: 'mcp',
        clientSecret: 'shh',
        audience: RESOURCE,
      }),
    ).toThrow(/OAUTH_ISSUER must be an absolute https URL/)
  })

  it('refuses a plaintext-http issuer', () => {
    // The exchange posts this server's client secret and the user's access
    // token to it.
    expect(() =>
      createOAuthGateway({
        issuer: 'http://login.meetergo.com/realms/meetergo',
        clientId: 'mcp',
        clientSecret: 'shh',
        audience: RESOURCE,
      }),
    ).toThrow(/must be https/)
  })

  it('trims a trailing slash, which the `iss` claim never carries', () => {
    // Left in place it matches no token, and the failure message compares two
    // issuer strings that look identical.
    expect(
      createOAuthGateway({
        issuer: `${ISSUER}/`,
        clientId: 'mcp',
        clientSecret: 'shh',
        audience: RESOURCE,
      })?.issuer,
    ).toBe(ISSUER)
  })

  it('offers no OAuth at all when a part is missing', async () => {
    // The chart's default state, and the one the review caught: an issuer with
    // no exchange credentials used to leave validation on and the exchange off,
    // which forwarded the user's own token to the api.
    const diagnostics = await captureDiagnostics(async () => {
      expect(
        createOAuthGateway({
          issuer: ISSUER,
          clientId: '',
          clientSecret: '',
          audience: RESOURCE,
        }),
      ).toBeUndefined()
    })

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'oauth_disabled_incomplete_config',
        missing: ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'],
      }),
    )
  })

  it('stays quiet when OAuth is deliberately not configured', async () => {
    // Bearer-token-only is a supported deployment, not a warning.
    const diagnostics = await captureDiagnostics(async () => {
      expect(createOAuthGateway({ audience: RESOURCE })).toBeUndefined()
    })
    expect(diagnostics).toEqual([])
  })

  it('reports a misconfiguration by variable name, never by value', async () => {
    const diagnostics = await captureDiagnostics(async () => {
      createOAuthGateway({
        clientId: 'mcp',
        clientSecret: 'super-secret',
        audience: RESOURCE,
      })
    })

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ missing: ['OAUTH_ISSUER'] }),
    )
    expect(JSON.stringify(diagnostics)).not.toContain('super-secret')
  })
})
