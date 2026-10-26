/**
 * Availability SCHEDULES (weekly working hours + date exceptions), as opposed
 * to `get_availability` in tools.ts, which looks up FREE BOOKING SLOTS for a
 * meeting type. Every tool here says "schedule" or "exception" in its name so
 * a model cannot mix the two up.
 *
 * All routes live at the host root (`/availability`, `/availability-exception`),
 * hence `root: true`. `userId` is an optional query on most of them: it lets an
 * admin act for a team member, and defaults to the caller.
 */
import { z } from 'zod/v3'
import { any, bool, list, numOrStr, out, str } from './output-helpers.js'
import { definedOnly, iso } from './tool-helpers.js'
import type { ToolDefinition } from './tools.js'

const day = z.object({
  enabled: z.boolean(),
  hours: z
    .array(z.object({ start: z.string(), end: z.string() }))
    .describe('Open ranges that day, e.g. [{ "start": "09:00", "end": "17:00" }]'),
})

const weeklySchedule = z
  .object({
    monday: day,
    tuesday: day,
    wednesday: day,
    thursday: day,
    friday: day,
    saturday: day,
    sunday: day,
  })
  .describe('Weekly hours. All seven days are required by the API; use enabled:false, hours:[] for days off.')

const exceptionFields = {
  available: z.boolean().describe('true = extra open time, false = blocked time'),
  start: iso,
  end: iso,
  title: z.string().optional(),
  note: z.string().optional(),
}

const holidayCountry = z
  .enum(['DE', 'AT', 'BE', 'CA', 'DK', 'NL', 'EE', 'FI', 'FR', 'IT', 'NZ', 'ES', 'SE', 'CH', 'US'])
  .describe('Country whose public holidays are blocked')
const holidayState = z
  .enum(['BW', 'BY', 'ST', 'MV', 'BE', 'BB', 'HE', 'NW', 'RP', 'SL', 'SN', 'TH', 'SH', 'HH', 'NI', 'HB'])
  .optional()
  .describe('German federal state, for country DE')
const holidayYear = z.number().int().min(2025).max(2027)

const userIdQuery = z
  .string()
  .optional()
  .describe('Act for this team member instead of yourself')

/** Rejects fields that only make sense in the other mode, so nothing is silently dropped. */
function reject(args: Record<string, unknown>, keys: string[], why: string): void {
  const bad = keys.filter((k) => args[k] !== undefined)
  if (bad.length > 0) throw new Error(`${bad.join(', ')} ${why}`)
}

function need(args: Record<string, unknown>, keys: string[], what: string): void {
  const missing = keys.filter((k) => args[k] === undefined)
  if (missing.length > 0) throw new Error(`${what} needs ${missing.join(', ')}`)
}

export const AVAILABILITY_TOOLS: ToolDefinition[] = [
  {
    name: 'get_availability_schedule',
    title: 'Get availability schedules',
    description:
      'Read weekly working-hours schedules (with their exceptions). With scheduleId: that schedule, or with meetingTypes:true the meeting types that use it. With userIds: the schedules of several people. Otherwise: your schedules (or userId\'s). This is NOT the free-slot lookup — use the free-slot lookup for bookable times.',
    schema: {
      scheduleId: z.string().optional(),
      meetingTypes: z
        .boolean()
        .optional()
        .describe('With scheduleId: list the meeting types that use this schedule instead'),
      userId: userIdQuery,
      userIds: z.array(z.string()).optional().describe('Several team members at once'),
    },
    readOnly: true,
    run: async (client, { scheduleId, meetingTypes, userId, userIds }) => {
      if (scheduleId) {
        reject({ userIds }, ['userIds'], 'cannot be combined with scheduleId')
        return client.request(
          'GET',
          `/availability/${scheduleId}${meetingTypes ? '/meeting-types' : ''}`,
          { query: { userId }, root: true },
        )
      }
      if (meetingTypes) throw new Error('meetingTypes needs scheduleId')
      if (userIds && userIds.length > 0) {
        return client.request('GET', '/availability/many', { query: { userIds }, root: true })
      }
      return client.request('GET', '/availability', { query: { userId }, root: true })
    },
  },
  {
    name: 'list_availability_exceptions',
    title: 'List availability exceptions',
    description:
      "List date-specific exceptions (holidays, blocked or extra hours): your own, or the company-wide ones that apply to everyone.",
    schema: { scope: z.enum(['user', 'company']).default('user') },
    readOnly: true,
    run: (client, { scope }) =>
      client.request('GET', `/availability-exception/${scope ?? 'user'}`, { root: true }),
  },
  {
    name: 'save_availability_schedule',
    title: 'Create or update an availability schedule',
    description:
      'Create a weekly schedule (no scheduleId; name and timezone required) or change one (scheduleId; only supplied fields change). Send the full seven-day schedule when you set hours.',
    schema: {
      scheduleId: z.string().optional().describe('Set to update; omit to create'),
      userId: userIdQuery,
      name: z.string().optional(),
      timezone: z.string().optional().describe('IANA zone, e.g. Europe/Berlin'),
      schedule: weeklySchedule.optional(),
      exceptions: z
        .array(z.object(exceptionFields))
        .optional()
        .describe('Create only: date exceptions to add right away'),
      useExplicitAvailability: z
        .boolean()
        .optional()
        .describe('Update only: only calendar events with explicitAvailabilityEventTitle count as open time'),
      explicitAvailabilityEventTitle: z.string().nullable().optional().describe('Update only'),
    },
    readOnly: false,
    run: async (client, args) => {
      const { scheduleId, userId, ...rest } = args
      const query = { userId }
      if (scheduleId) {
        reject(rest, ['exceptions'], 'can only be set when creating a schedule')
        return client.request('PATCH', `/availability/${scheduleId}`, {
          query,
          body: definedOnly(rest),
          root: true,
        })
      }
      need(rest, ['name', 'timezone'], 'creating a schedule')
      reject(
        rest,
        ['useExplicitAvailability', 'explicitAvailabilityEventTitle'],
        'can only be set when updating a schedule',
      )
      return client.request('POST', '/availability', {
        query,
        body: definedOnly(rest),
        root: true,
      })
    },
  },
  {
    name: 'delete_availability_schedule',
    title: 'Delete an availability schedule',
    description:
      'Permanently delete a weekly schedule. Meeting types using it may fall back to another schedule; confirm with the user first. There is no undo.',
    schema: { scheduleId: z.string(), userId: userIdQuery },
    readOnly: false,
    destructive: true,
    run: (client, { scheduleId, userId }) =>
      client.request('DELETE', `/availability/${scheduleId}`, { query: { userId }, root: true }),
  },
  {
    name: 'availability_schedule_action',
    title: 'Set default, apply to users or add holidays',
    description:
      'set_default: make a schedule the default (yours, or userId\'s). apply_to_users: assign a schedule to up to 100 people (setAsDefault also makes it their default). add_holidays: block a country\'s public holidays on one schedule. add_holidays_for_users: same for up to 100 people. These change other people\'s calendars: confirm the exact users first.',
    schema: {
      action: z.enum(['set_default', 'apply_to_users', 'add_holidays', 'add_holidays_for_users']),
      scheduleId: z
        .string()
        .optional()
        .describe('Required for set_default, apply_to_users, add_holidays'),
      userId: userIdQuery.describe('set_default only: act for this team member'),
      userIds: z
        .array(z.string())
        .max(100)
        .optional()
        .describe('apply_to_users, add_holidays_for_users'),
      setAsDefault: z.boolean().optional().describe('apply_to_users only'),
      year: holidayYear.optional().describe('add_holidays*: 2025-2027'),
      country: holidayCountry.optional().describe('add_holidays*'),
      germanState: holidayState,
    },
    readOnly: false,
    run: async (client, args) => {
      const { action, scheduleId, userId, userIds, setAsDefault, year, country, germanState } = args
      switch (action) {
        case 'set_default':
          need(args, ['scheduleId'], 'set_default')
          return client.request('POST', `/availability/default/${scheduleId}`, {
            query: { userId },
            root: true,
          })
        case 'apply_to_users':
          need(args, ['scheduleId', 'userIds'], 'apply_to_users')
          return client.request('POST', `/availability/${scheduleId}/apply-to-users`, {
            body: definedOnly({ userIds, setAsDefault }),
            root: true,
          })
        case 'add_holidays':
          need(args, ['scheduleId', 'year', 'country'], 'add_holidays')
          return client.request('PATCH', `/availability/${scheduleId}/holiday-exceptions`, {
            body: definedOnly({ year, country, germanState }),
            root: true,
          })
        case 'add_holidays_for_users':
          need(args, ['userIds', 'year', 'country'], 'add_holidays_for_users')
          return client.request('POST', '/availability/bulk-holidays', {
            body: definedOnly({ userIds, year, country, germanState }),
            root: true,
          })
        default:
          throw new Error(`unknown action ${String(action)}`)
      }
    },
  },
  {
    name: 'save_availability_exception',
    title: 'Create or update an availability exception',
    description:
      'Block or open a specific date range. Without exceptionId it creates one: scope "user" (yours, or userId\'s) or "company" (applies to EVERYONE; confirm first). With exceptionId it replaces that exception, so resend available, start and end.',
    schema: {
      exceptionId: z.string().optional().describe('Set to update; omit to create'),
      scope: z.enum(['user', 'company']).optional().describe('Create only'),
      userId: userIdQuery,
      ...exceptionFields,
      availabilityId: z
        .string()
        .optional()
        .describe('Attach to this schedule; defaults to the default schedule'),
    },
    readOnly: false,
    run: async (client, { exceptionId, scope, userId, ...body }) => {
      if (exceptionId) {
        reject({ scope }, ['scope'], 'can only be set when creating an exception')
        return client.request('PUT', `/availability-exception/${exceptionId}`, {
          query: { userId },
          body: definedOnly(body),
          root: true,
        })
      }
      if (!scope) throw new Error('creating an exception needs scope (user or company)')
      if (scope === 'company') reject({ userId }, ['userId'], 'does not apply to company exceptions')
      return client.request('POST', `/availability-exception/${scope}`, {
        query: scope === 'user' ? { userId } : undefined,
        body: definedOnly(body),
        root: true,
      })
    },
  },
  {
    name: 'delete_availability_exception',
    title: 'Delete an availability exception',
    description: 'Permanently delete a date exception. A company exception disappears for everyone; confirm first.',
    schema: { exceptionId: z.string(), userId: userIdQuery },
    readOnly: false,
    destructive: true,
    run: (client, { exceptionId, userId }) =>
      client.request('DELETE', `/availability-exception/${exceptionId}`, {
        query: { userId },
        root: true,
      }),
  },
]

const exception = out(
  {
    id: numOrStr,
    ownerId: str,
    ownerType: str,
    available: bool,
    start: str,
    end: str,
    title: str,
    note: str,
    createdAt: str,
    deletedAt: str,
  },
  'A date-specific exception to the weekly hours',
)

const schedule = out(
  {
    id: str,
    name: str,
    timezone: str,
    schedule: any('Weekly hours per day: { monday: { enabled, hours: [{ start, end }] }, ... }'),
    availabilityExceptions: list(exception),
    isDefault: bool,
    createdAt: str,
    ownerName: str,
    useExplicitAvailability: bool,
    explicitAvailabilityEventTitle: str,
    scheduleSource: any("'manual' or 'outlook'"),
    // /availability/many wraps each person's schedules like this.
    userId: str.describe('Only in the multi-user listing'),
    items: any("Only in the multi-user listing: that person's schedules"),
  },
  'An availability schedule, or in the multi-user listing a { userId, items } entry',
)

const listOf = (item: z.ZodTypeAny, description: string) =>
  out({ items: list(item).describe('The results') }, description)

export const AVAILABILITY_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  // One schedule, a list ({ items }), or the meeting-types sub-route (shape per API).
  get_availability_schedule: schedule,
  list_availability_exceptions: listOf(exception, 'Date exceptions'),
  save_availability_schedule: schedule,
  delete_availability_schedule: out({ ok: bool }, 'Empty success'),
  availability_schedule_action: out(
    { ok: bool },
    'Result of the action (response shape per API; empty on success)',
  ),
  save_availability_exception: exception,
  delete_availability_exception: out({ ok: bool }, 'Empty success'),
}
