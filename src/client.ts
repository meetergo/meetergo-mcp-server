/**
 * Thin REST client for the meetergo Platform API.
 *
 * Deliberately not the generated SDK (`@meetergo/api-client`): that package is
 * generated FROM apps/api, and the eslint no-restricted-imports rule exists
 * because depending on it couples release cycles. This server talks to the
 * public HTTP surface exactly as a third-party integrator would — which is also
 * the surface we are asking agent builders to trust.
 */

/**
 * Versioned endpoints live under `/v4`. The CRM (`/crm`) does not — it predates
 * the v4 split and is mounted at the host root. `request()` takes a `root` flag
 * rather than a full URL so there is exactly one place that knows this, and so
 * MEETERGO_API_URL keeps working for staging hosts.
 */
export const DEFAULT_BASE_URL = 'https://api.meetergo.com/v4'
/** Production apps/next root — where the Mira widget loader is served from. */
export const DEFAULT_NEXT_URL = 'https://cal.meetergo.com'

/**
 * Transient by nature: rate limiting and upstream hiccups. Anything else is a
 * real answer, and retrying it just burns the agent's turn.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 30_000
/**
 * Retry-After can name a date instead of seconds; cap either reading so a wrong
 * or hostile header cannot park the agent for an hour.
 */
const MAX_RETRY_DELAY_MS = 20_000

/**
 * Platform API Keys look like `ak_live:<uuid>:<secret>` and can act for any user
 * in the company; Personal Access Tokens (`rgo-…`) always act as their owner and
 * are rejected outright if they send the impersonation header. Deciding from the
 * token shape means MEETERGO_USER_ID cannot be set into a guaranteed 403.
 */
export function isPlatformApiKey(token: string): boolean {
  return token.startsWith('ak_live:')
}

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
  /**
   * Personal Access Token (`rgo-…`, acts as its owner) or Platform API Key
   * (`ak_live:<uuid>:<secret>`, acts for any user in the company).
   */
  token: string
  /**
   * Target user for a Platform API Key, sent as `x-meetergo-api-user-id`.
   * Personal Access Tokens cannot impersonate — the API rejects the header
   * outright when it names anyone but the owner — so this stays unset for them.
   */
  userId?: string
  baseUrl?: string
  timeoutMs?: number
  userAgent?: string
  /**
   * Root of the apps/next deployment that hosts the Mira widget loader
   * (`/mira-widget.js`) and iframe page. Only used to RENDER install snippets
   * and preview URLs — never requested by this client. Overridable for local
   * stacks via MEETERGO_NEXT_URL.
   */
  nextUrl?: string
}

export interface RequestOptions {
  query?: Record<string, unknown>
  body?: unknown
  /** Target the host root instead of the versioned base — see DEFAULT_BASE_URL. */
  root?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** AbortSignal.timeout raises a bare "signal timed out"; name the budget instead. */
function asTransportError(error: unknown, timeoutMs: number): Error {
  return (error as Error)?.name === 'TimeoutError'
    ? new Error(`request timed out after ${timeoutMs}ms`)
    : (error as Error)
}

/** Seconds or an HTTP-date, per RFC 9110. Null when absent or unparseable. */
export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
  }

  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.min(Math.max(date - now, 0), MAX_RETRY_DELAY_MS)
}

export class MeetergoClient {
  private readonly token: string
  private readonly userId?: string
  private readonly baseUrl: string
  private readonly rootUrl: string
  private readonly timeoutMs: number
  private readonly userAgent: string
  readonly nextUrl: string

  constructor({
    token,
    userId,
    baseUrl,
    timeoutMs,
    userAgent,
    nextUrl,
  }: MeetergoClientOptions) {
    this.token = token
    this.userId = userId
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    // Strip exactly one trailing `/v4`, so a staging host on a path prefix
    // (https://staging.example.com/api/v4) still resolves /crm correctly.
    this.rootUrl = this.baseUrl.replace(/\/v4$/, '')
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.userAgent = userAgent ?? 'meetergo-mcp'
    this.nextUrl = (nextUrl ?? DEFAULT_NEXT_URL).replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      // Lets us tell agent traffic apart from browser and integration traffic
      // in API analytics, which is the only way to know this server is used.
      'User-Agent': this.userAgent,
    }
    if (this.userId) headers['x-meetergo-api-user-id'] = this.userId
    return headers
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${options.root ? this.rootUrl : this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      // Array-valued filters (tags, attendeeIds) repeat the key rather than
      // stringifying to "a,b" — class-validator's @IsString({ each: true })
      // rejects the comma form.
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry))
        continue
      }
      url.searchParams.set(key, String(value))
    }

    // A GET can always be repeated. A POST/PATCH/DELETE cannot: if the request
    // reached the API and only the *response* was lost, retrying books the
    // meeting twice and sends the invitation twice. The API has no idempotency
    // key, so the only safe rule is not to repeat unsafe methods on an
    // ambiguous failure — a timeout, a dropped connection, or a 502/503/504,
    // any of which can follow a mutation the server already applied.
    const isSafeMethod = method === 'GET'

    let lastError: Error | undefined

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const isFinalAttempt = attempt === MAX_ATTEMPTS - 1
      let response: Response
      try {
        response = await fetch(url, {
          method,
          headers: this.headers(),
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          // Without this a stalled connection hangs the tool call forever, and
          // the MCP host has no way to cancel it — the agent simply stops.
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error: unknown) {
        // Ambiguous by definition: the request may or may not have been applied.
        lastError = asTransportError(error, this.timeoutMs)
        if (isSafeMethod && !isFinalAttempt) {
          await sleep(500 * 2 ** attempt)
          continue
        }
        throw lastError
      }

      if (RETRYABLE_STATUSES.has(response.status) && !isFinalAttempt) {
        // 429 is the one unambiguous case: the server states it did not process
        // the request, so repeating it cannot duplicate anything. The 5xx codes
        // carry no such promise and are only retried for safe methods.
        if (response.status === 429 || isSafeMethod) {
          const delay =
            parseRetryAfter(response.headers.get('retry-after')) ??
            500 * 2 ** attempt
          await sleep(delay)
          continue
        }
      }

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
        throw new MeetergoApiError(
          response.status,
          message || response.statusText,
        )
      }

      if (response.status === 204) return undefined as T

      // The body arrives after the headers, so it can stall or reset on its own.
      // Same rule applies: a failure here on a mutation means the write landed
      // and only the confirmation was lost.
      let text: string
      try {
        text = await response.text()
      } catch (error: unknown) {
        lastError = asTransportError(error, this.timeoutMs)
        if (isSafeMethod && !isFinalAttempt) {
          await sleep(500 * 2 ** attempt)
          continue
        }
        throw lastError
      }

      if (!text) return undefined as T
      return JSON.parse(text) as T
    }

    // Unreachable: the final attempt either returns or throws above.
    throw lastError ?? new Error('request failed')
  }
}
