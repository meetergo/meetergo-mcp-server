import { z } from 'zod'
import type { MeetergoClient } from './client.js'

/**
 * The agent-facing tool surface.
 *
 * The OpenAPI spec has 100 operations. Exposing all of them would be the
 * obvious move and the wrong one: every tool definition costs context in the
 * model's window, and an agent choosing between 100 near-identical operations
 * picks worse than one choosing between nine. These nine are the loop that
 * makes the claim "an agent runs your calendar" true — discover, schedule,
 * change, review, protect.
 *
 * Anything outside this list is still reachable over REST. The point of a
 * curated surface is that the common path is obvious, not that the API is
 * hidden.
 */

export interface ToolDefinition {
  name: string
  title: string
  description: string
  schema: z.ZodRawShape
  /** Mutations are annotated so hosts can gate them behind confirmation. */
  readOnly: boolean
  /**
   * The MCP SDK infers handler arguments from the zod shape as a record with an
   * `any` index signature. Mirroring that is what lets one registration loop in
   * index.ts serve nine differently-shaped tools; narrowing it here would mean
   * a bespoke registration per tool for no safety gain, since the SDK has
   * already validated against the schema by this point.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (client: MeetergoClient, args: Record<string, any>) => Promise<unknown>
}

const iso = z
  .string()
  .describe('ISO 8601 timestamp, e.g. 2026-08-04T09:00:00Z')

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_meeting_types',
    title: 'List meeting types',
    description:
      'List the meeting types that can be booked. Start here: every booking needs a meetingTypeId, and the duration and host come from the meeting type.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/meeting-type'),
  },
  {
    name: 'get_availability',
    title: 'Get available slots',
    description:
      'Get bookable time slots for a meeting type in a date range. Returns the slots a booking will actually be accepted for — do not infer availability from the calendar.',
    schema: {
      meetingTypeId: z.string().describe('From list_meeting_types'),
      from: iso.describe('Start of the search window'),
      to: iso.describe('End of the search window'),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone, e.g. Europe/Berlin. Defaults to the host.'),
    },
    readOnly: true,
    run: (client, args) =>
      client.request('GET', '/booking-availability', { query: args }),
  },
  {
    name: 'book_appointment',
    title: 'Book an appointment',
    description:
      'Book a slot. Use a start time returned by get_availability — booking an unlisted slot is rejected. Creates a real appointment and sends real invitations.',
    schema: {
      meetingTypeId: z.string(),
      start: iso.describe('Slot start, from get_availability'),
      name: z.string().describe('Attendee full name'),
      email: z.string().email().describe('Attendee email'),
      timezone: z.string().optional(),
      notes: z.string().optional().describe('Context for the host'),
    },
    readOnly: false,
    run: (client, args) => client.request('POST', '/booking', { body: args }),
  },
  {
    name: 'reschedule_appointment',
    title: 'Reschedule an appointment',
    description:
      'Move an appointment to a new start time. Duration is unchanged. Validates availability unless ignoreAvailability is set.',
    schema: {
      appointmentId: z.string(),
      start: iso.describe('New start time'),
      ignoreAvailability: z
        .boolean()
        .optional()
        .describe('Schedule outside available hours or over an existing booking'),
    },
    readOnly: false,
    run: (client, { appointmentId, ...body }) =>
      client.request('POST', `/appointment/${appointmentId}/reschedule`, { body }),
  },
  {
    name: 'cancel_appointment',
    title: 'Cancel an appointment',
    description:
      'Cancel an appointment and notify attendees. For a group booking pass attendeeId to remove one person, or cancelAll to cancel the whole appointment — passing neither is rejected, so a bulk cancel is never accidental.',
    schema: {
      appointmentId: z.string(),
      attendeeId: z.string().optional().describe('Remove a single attendee'),
      cancelAll: z.boolean().optional().describe('Cancel the entire appointment'),
      reason: z.string().optional(),
    },
    readOnly: false,
    run: (client, { appointmentId, ...body }) =>
      client.request('POST', `/appointment/${appointmentId}/cancel`, { body }),
  },
  {
    name: 'list_appointments',
    title: 'List appointments',
    description:
      'List upcoming and past appointments with pagination. Use for "what is on my calendar" and for finding an appointmentId to change.',
    schema: {
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    run: (client, args) => client.request('GET', '/appointment', { query: args }),
  },
  {
    name: 'get_todays_appointments',
    title: "Get today's appointments",
    description:
      "Today's appointments for the authenticated user. Cheaper and more precise than filtering list_appointments by date.",
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/appointment/today'),
  },
  {
    name: 'add_guests',
    title: 'Add guests to an appointment',
    description:
      'Add guest email addresses to an existing appointment. They receive the invitation and updates.',
    schema: {
      appointmentId: z.string(),
      emails: z.array(z.string().email()).min(1),
    },
    readOnly: false,
    run: (client, { appointmentId, ...body }) =>
      client.request('PATCH', `/appointment/${appointmentId}/guest-emails`, {
        body,
      }),
  },
  {
    name: 'list_calendar_connections',
    title: 'List calendar connections',
    description:
      'List connected calendars (Google, Outlook). Use to check whether a host actually has a calendar attached before diagnosing why availability looks wrong.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/calendar-connections'),
  },
]
