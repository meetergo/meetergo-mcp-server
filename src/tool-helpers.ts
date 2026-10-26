/**
 * Request-side helpers shared by tools.ts and the per-area tool modules
 * (tools-docs.ts, tools-invoicing.ts, ...). Lives in its own file so those
 * modules can use them without importing tools.ts, which imports them.
 */
import { z } from 'zod'

export const iso = z.string().describe('ISO 8601 timestamp, e.g. 2026-08-04T09:00:00Z')

/** Shared pagination for the list endpoints that use limit/offset. */
export const listLimit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Max results, 1-100. Defaults to 50.')
export const listOffset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('How many to skip. Defaults to 0.')

/** Drops keys the caller never set, so a patch stays a patch. */
export function definedOnly(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined),
  )
}
