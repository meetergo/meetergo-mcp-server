/**
 * SSRF-guarded fetch for the one tool that reaches an arbitrary,
 * caller-supplied URL (verify_widget_install).
 *
 * The threat is not the customer checking their own homepage — it is a URL
 * that resolves to somewhere the caller could not reach directly: cloud
 * metadata (169.254.169.254), localhost, a cluster-internal service from the
 * hosted pod, or the user's own intranet from the npm install. The API's
 * safeHttpRequest solves the same problem the same way; this is that logic
 * without the NestJS surroundings, because this package ships standalone with
 * two runtime dependencies.
 *
 * Rules: resolve the hostname ourselves and reject when ANY resolved address
 * is non-public; never let fetch follow a redirect (each hop re-enters the
 * same check); read the body as a stream and stop at the cap instead of
 * buffering whatever the server feels like sending.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_REDIRECTS = 5

/** IPv4 ranges that must never be fetched. Broad on purpose. */
function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true
  const [a, b] = octets
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 special-purpose
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved + broadcast
  )
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  // IPv4-mapped (::ffff:10.0.0.1) — judge the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1])
  return (
    lower === '::' ||
    lower === '::1' || // loopback
    lower.startsWith('fe8') || // link-local fe80::/10
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fc') || // unique-local fc00::/7
    lower.startsWith('fd')
  )
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIpv4(address)
  if (family === 6) return isPrivateIpv6(address)
  return true // not an IP literal — the caller resolved wrong
}

/**
 * Throws unless every address the hostname resolves to is public. Checking
 * every record, not the first, closes the trivial half of DNS rebinding: a
 * name that answers [public, 127.0.0.1] never gets fetched at all.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  // URL keeps IPv6 literals in brackets; strip them for isIP/lookup.
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) {
      throw new Error(`"${bare}" is not a public address.`)
    }
    return
  }
  let addresses
  try {
    addresses = await lookup(bare, { all: true, verbatim: true })
  } catch {
    throw new Error(`"${bare}" does not resolve.`)
  }
  if (addresses.length === 0) throw new Error(`"${bare}" does not resolve.`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`"${bare}" resolves to a non-public address.`)
    }
  }
}

/** Read at most maxBytes from the body, then stop — never buffer first. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (received >= maxBytes) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  const merged = new Uint8Array(Math.min(received, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, merged.byteLength - offset)
    merged.set(chunk.subarray(0, take), offset)
    offset += take
    if (offset >= merged.byteLength) break
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

export interface SafeFetchResult {
  status: number
  ok: boolean
  /** Final URL after redirects — each hop passed the same address check. */
  url: string
  body: string
}

export async function fetchPublicUrl(
  url: string,
  options: { timeoutMs: number; maxBytes: number; userAgent: string },
): Promise<SafeFetchResult> {
  const deadline = AbortSignal.timeout(options.timeoutMs)
  let current = new URL(url)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('Only http(s) URLs can be checked.')
    }
    await assertPublicHost(current.hostname)

    const response = await fetch(current, {
      headers: { 'user-agent': options.userAgent },
      // 'manual', never 'follow': a public host is free to answer with a 302
      // to a private one, and only re-entering the loop re-checks it.
      redirect: 'manual',
      signal: deadline,
    })

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) {
        return { status: response.status, ok: false, url: current.toString(), body: '' }
      }
      current = new URL(location, current)
      continue
    }

    return {
      status: response.status,
      ok: response.ok,
      url: current.toString(),
      body: response.ok ? await readCapped(response, options.maxBytes) : '',
    }
  }
  throw new Error('Too many redirects.')
}
