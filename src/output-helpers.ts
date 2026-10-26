/**
 * Building blocks for output schemas, shared by tool-outputs.ts and the
 * per-area tool modules. Kept apart from tool-outputs.ts so a module can
 * declare its own schemas without importing the registry that imports it.
 *
 * The rules (everything the API owns is optional and nullable, schemas are
 * `.passthrough()`) are explained at the top of tool-outputs.ts.
 */
import { z } from 'zod'

export const str = z.string().nullable().optional()
export const bool = z.boolean().nullable().optional()
export const num = z.number().nullable().optional()
// Data-field ids are numeric on this API, unlike every uuid string id
// elsewhere — confirmed live after create_data_field/update_data_field's
// structuredContent validation rejected the real numeric id as a string.
export const numOrStr = z.union([z.string(), z.number()]).nullable().optional()
export const any = (description: string) => z.unknown().optional().describe(description)
export const record = z.object({}).passthrough()
export const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().optional()

export function out(shape: z.ZodRawShape, description: string) {
  return z.object(shape).passthrough().describe(description)
}
