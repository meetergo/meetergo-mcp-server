/**
 * Structured diagnostics for the hosted entry.
 *
 * The stdio entry writes prose because a human is reading a terminal. This one
 * writes to a log pipeline (pod stderr → Alloy → Loki), where one JSON object
 * per line is queryable and a sentence is not. There is no NestJS logger here —
 * this is a plain node http server — so the shape is spelled out once, and
 * every line the process emits goes through it, startup included.
 *
 * stderr rather than stdout, for the same reason the stdio entry does it: the
 * MCP transport owns stdout, and a server that can be run either way should
 * never have a log line that depends on which. That is also why
 * apps/mcp-server/.eslintrc.json makes `no-console` an error: a stray
 * console.log interleaves with the JSON-RPC frames and breaks every stdio
 * client, so process.stderr.write — here and in src/index.ts — is the only way
 * out.
 *
 * Two rules about what must never appear here:
 *  - No credential values. Not the bearer token, not the client secret, not the
 *    exchanged token. Names of environment variables, yes; contents, never.
 *  - Anything lifted out of a token we have not verified is attacker-controlled
 *    text and goes through {@link safeText} first.
 */

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export function logDiagnostic(
  level: DiagnosticLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: 'mcp-server',
      event,
      ...fields,
    })}\n`,
  )
}

/** Longer than this is a payload, not a diagnostic. */
const MAX_DIAGNOSTIC_TEXT = 200

/**
 * Untrusted text, reduced to something safe to put in a log line: no control
 * characters (JSON escaping already neuters them, but a log viewer that renders
 * the string later does not), and bounded, so a token full of junk claims
 * cannot turn one bad request into a megabyte of logs.
 */
export function safeText(value: unknown, max = MAX_DIAGNOSTIC_TEXT): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, max)
}
