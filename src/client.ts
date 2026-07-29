/**
 * Thin REST client for the meetergo Platform API.
 *
 * Deliberately not the generated SDK (`@meetergo/api-client`): that package is
 * generated FROM apps/api, and the eslint no-restricted-imports rule exists
 * because depending on it couples release cycles. This server talks to the
 * public HTTP surface exactly as a third-party integrator would — which is also
 * the surface we are asking agent builders to trust.
 */

export const DEFAULT_BASE_URL = 'https://api.meetergo.com/v4'

export class MeetergoApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`meetergo API ${status}: ${detail}`)
    this.name = 'MeetergoApiError'
  }
}

export interface MeetergoClientOptions {
  /** Personal Access Token. Created at my.meetergo.com/integrations. */
  token: string
  baseUrl?: string
}

export class MeetergoClient {
  private readonly token: string
  private readonly baseUrl: string

  constructor({ token, baseUrl }: MeetergoClientOptions) {
    this.token = token
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (!response.ok) {
      // Surface the API's own message where it has one: an agent can act on
      // "slot no longer available" but not on a bare 409.
      const detail = await response.text().catch(() => '')
      let message = detail.slice(0, 400)
      try {
        const parsed = JSON.parse(detail) as { message?: string | string[] }
        if (parsed?.message) {
          message = Array.isArray(parsed.message)
            ? parsed.message.join('; ')
            : parsed.message
        }
      } catch {
        // Not JSON — the truncated body is the best detail available.
      }
      throw new MeetergoApiError(response.status, message || response.statusText)
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
}
