import { z } from 'zod'
import type { MeetergoClient } from './client.js'

/**
 * The agent-facing tool surface.
 *
 * The OpenAPI spec has 100 operations. Exposing all of them would be the
 * obvious move and the wrong one: every tool definition costs context in the
 * model's window, and an agent choosing between 100 near-identical operations
 * picks worse than one choosing between fifteen. These fifteen are the loops
 * that make the claim "an agent runs your calendar" true — discover, schedule,
 * change, review, follow up, and keep the contact record straight.
 *
 * The bar for adding a tool is that it closes a loop an agent can actually
 * complete on its own. Config surfaces that would have the agent inventing a
 * large request body from a docstring (meeting-type creation, routing-form
 * definitions, page branding) stay out: they are better done in the dashboard,
 * and a mistyped `dict` payload is worse than no tool. Everything outside this
 * list is still reachable over REST.
 */

export interface ToolDefinition {
  name: string
  title: string
  description: string
  schema: z.ZodRawShape
  /** Mutations are annotated so hosts can gate them behind confirmation. */
  readOnly: boolean
  /** Set on tools that remove or irreversibly alter something. */
  destructive?: boolean
  /**
   * The MCP SDK infers handler arguments from the zod shape as a record with an
   * `any` index signature. Mirroring that is what lets one registration loop in
   * index.ts serve every tool; narrowing it here would mean a bespoke
   * registration per tool for no safety gain, since the SDK has already
   * validated against the schema by this point.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (client: MeetergoClient, args: Record<string, any>) => Promise<unknown>
}

const iso = z.string().describe('ISO 8601 timestamp, e.g. 2026-08-04T09:00:00Z')

interface MeetingTypeScope {
  id: string
  userId?: string
  queueId?: string
}

/**
 * Availability has to be told WHICH hosts to compute for: a queue meeting type
 * by its `queueId`, otherwise the owner as the single host. Without one the API
 * rejects with 400 "Expected hostIds or queueId" — and it checks this before it
 * loads the meeting type, so passing only a meetingTypeId never works.
 *
 * The model only ever has a meetingTypeId, so the tool spends one extra GET to
 * resolve the scope rather than pushing a concept onto the agent that it has no
 * way to discover. `apps/next` solves the same problem the same way
 * (`resolveScope` in `apps/next/src/app/mira/_lib/meetergo.ts`).
 */
async function resolveHostScope(
  client: MeetergoClient,
  meetingTypeId: string,
): Promise<{ queueId?: string; hostIds?: string[] }> {
  const meetingType = await client.request<MeetingTypeScope>(
    'GET',
    `/meeting-type/${meetingTypeId}`,
  )
  if (meetingType?.queueId) return { queueId: meetingType.queueId }
  if (meetingType?.userId) return { hostIds: [meetingType.userId] }
  throw new Error(
    `Meeting type ${meetingTypeId} has no host or queue configured, so availability cannot be calculated.`,
  )
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_me',
    title: 'Get the authenticated user',
    description:
      'Return the account this server is authenticated as. Call it first to confirm the token works and to get the userId — it is the cheapest way to tell a bad token apart from a genuinely empty calendar.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/user/me'),
  },
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
      start: iso.describe('Start of the search window'),
      end: iso.describe('End of the search window'),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone, e.g. Europe/Berlin. Defaults to the host.'),
      meetingDuration: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Override the meeting type duration in minutes, where the meeting type allows it. Pass the same value to book_appointment as `duration`, or the booking reverts to the default length.',
        ),
      existingAppointmentId: z
        .string()
        .optional()
        .describe(
          'When checking slots for a reschedule, so the current booking does not block itself',
        ),
      hostIds: z
        .array(z.string())
        .optional()
        .describe(
          'Only to narrow a round-robin type to specific hosts. Left out, the meeting type decides.',
        ),
      queueId: z
        .string()
        .optional()
        .describe('Rarely needed — resolved from the meeting type by default.'),
    },
    readOnly: true,
    run: async (client, args) => {
      const { hostIds, queueId, ...rest } = args
      const scope =
        hostIds?.length || queueId
          ? { hostIds, queueId }
          : await resolveHostScope(client, args.meetingTypeId)
      return client.request('GET', '/booking-availability', {
        query: { ...rest, ...scope },
      })
    },
  },
  {
    name: 'book_appointment',
    title: 'Book an appointment',
    description:
      'Book a slot. Use a start time returned by get_availability — booking an unlisted slot is rejected. Creates a real appointment and sends real invitations. Provide either fullName, or firstName and lastName.',
    schema: {
      meetingTypeId: z.string(),
      start: iso.describe('Slot start, from get_availability'),
      duration: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Length in minutes. Required only if you passed meetingDuration to get_availability — otherwise the meeting type decides.',
        ),
      email: z.string().email().describe('Attendee email'),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      fullName: z
        .string()
        .optional()
        .describe('Use when the name cannot be split reliably'),
      phone: z.string().optional(),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone of the attendee, e.g. Europe/Berlin"),
      receiveReminders: z
        .boolean()
        .optional()
        .describe('Send the attendee reminder emails. Defaults to true.'),
      notes: z
        .record(z.string())
        .optional()
        .describe(
          'Answers to the booking form, keyed by question label, e.g. {"What do you want to discuss?": "Pricing"}',
        ),
      guestEmails: z
        .array(z.string().email())
        .max(5)
        .optional()
        .describe('Additional attendees invited alongside the main one (max 5)'),
      hostIds: z
        .array(z.string())
        .optional()
        .describe(
          'Only to pin a round-robin type to specific hosts. Left out, the meeting type decides.',
        ),
      queueId: z
        .string()
        .optional()
        .describe('Rarely needed — resolved from the meeting type by default.'),
    },
    readOnly: false,
    run: async (
      client,
      {
        meetingTypeId,
        start,
        duration,
        email,
        firstName,
        lastName,
        fullName,
        phone,
        timezone,
        receiveReminders,
        notes,
        guestEmails,
        hostIds,
        queueId,
      },
    ) => {
      // The API accepts an attendee with no name at all and writes an empty one
      // into the invitation and the CRM. Refuse here, where the agent can still
      // go and ask, rather than producing a nameless booking nobody notices.
      if (!fullName && !firstName && !lastName) {
        throw new Error(
          'Provide the attendee name: either fullName, or firstName and lastName.',
        )
      }

      const scope =
        hostIds?.length || queueId
          ? { hostIds, queueId }
          : await resolveHostScope(client, meetingTypeId)

      return client.request('POST', '/booking', {
        // The API takes a nested attendee and requires `receiveReminders` and
        // `notes` to be present — an agent that omits them gets a validation
        // error it cannot diagnose, so default them here rather than making the
        // model supply boilerplate. `dataPolicyAccepted` mirrors the booking
        // page's consent checkbox: the attendee asked for this booking through
        // whoever is driving the agent.
        body: {
          meetingTypeId,
          start,
          duration,
          ...scope,
          attendee: {
            email,
            firstname: firstName,
            lastname: lastName,
            fullname: fullName,
            phone,
            timezone,
            receiveReminders: receiveReminders ?? true,
            dataPolicyAccepted: true,
            notes: notes ?? {},
            bringalongEmails: guestEmails,
          },
        },
      })
    },
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
      client.request('POST', `/appointment/${appointmentId}/reschedule`, {
        body,
      }),
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
      cancelEntireSeries: z
        .boolean()
        .optional()
        .describe('For a recurring appointment, cancel every occurrence'),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe('Included in the notification emails to participants'),
    },
    readOnly: false,
    destructive: true,
    run: (client, { appointmentId, ...body }) =>
      client.request('POST', `/appointment/${appointmentId}/cancel`, { body }),
  },
  {
    name: 'list_appointments',
    title: 'List appointments',
    description:
      'List appointments with pagination and filters. Use for "what is on my calendar" and for finding an appointmentId to change. Pages are 0-indexed.',
    schema: {
      page: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-indexed page number. Defaults to 0.'),
      pageSize: z.number().int().min(1).max(100).optional(),
      start: iso.optional().describe('Only appointments starting at or after this'),
      end: iso.optional().describe('Only appointments starting at or before this'),
      search: z.string().optional().describe('Free-text search'),
      status: z.string().optional(),
      meetingTypeId: z.string().optional(),
      sortBy: z.enum(['appointment.start', 'appointment.createdAt']).optional(),
      sortDirection: z.enum(['ASC', 'DESC']).optional(),
    },
    readOnly: true,
    // `page` and `pageSize` are required by the API with no defaults. Filling
    // them in beats making every caller remember, and beats a 400 the agent
    // reads as "no appointments".
    run: (client, { page, pageSize, ...rest }) =>
      client.request('GET', '/appointment/paginated', {
        query: { page: page ?? 0, pageSize: pageSize ?? 20, ...rest },
      }),
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
    name: 'get_appointment',
    title: 'Get an appointment',
    description:
      'Full detail for one appointment: attendees and their attendeeIds, hosts, location, notes. Needed before add_guest or a per-attendee cancel, both of which take an attendeeId this returns.',
    schema: { appointmentId: z.string() },
    readOnly: true,
    run: (client, { appointmentId }) =>
      client.request('GET', `/appointment/${appointmentId}`),
  },
  {
    name: 'add_guest',
    title: 'Add a guest to an appointment',
    description:
      'Add one guest email to an appointment. They receive the invitation and updates. Takes the attendeeId of the attendee the guest belongs to — get it from get_appointment. Call once per guest.',
    schema: {
      appointmentId: z.string(),
      attendeeId: z
        .string()
        .describe('The attendee to attach the guest to, from get_appointment'),
      email: z.string().email(),
    },
    readOnly: false,
    run: (client, { appointmentId, ...body }) =>
      client.request('PATCH', `/appointment/${appointmentId}/guest`, { body }),
  },
  {
    name: 'update_appointment_notes',
    title: 'Update appointment notes',
    description:
      'Replace the host-side note on an appointment. Use it to write back call prep or an outcome summary. Replaces the note rather than appending — read get_appointment first if you need to keep what is there.',
    schema: {
      appointmentId: z.string(),
      note: z.string(),
    },
    readOnly: false,
    run: (client, { appointmentId, note }) =>
      client.request('PATCH', `/appointment/${appointmentId}/notes`, {
        body: { note },
      }),
  },
  {
    name: 'create_one_time_booking_link',
    title: 'Create a one-time booking link',
    description:
      'Generate a single-use booking link for a meeting type. Use when sending someone a link to pick their own slot, instead of booking on their behalf — no attendee details needed and the link cannot be reshared.',
    schema: { meetingTypeId: z.string() },
    readOnly: false,
    run: (client, { meetingTypeId }) =>
      client.request('POST', `/one-time-booking-link/create/${meetingTypeId}`),
  },
  {
    name: 'search_contacts',
    title: 'Search CRM contacts',
    description:
      'Search the CRM by name, email, phone or tag. Use it to check whether someone already exists before creating them, and to find a contactId.',
    schema: {
      searchTerm: z.string().optional().describe('Matches name, email or phone'),
      tags: z.array(z.string()).optional(),
      ownerId: z.string().optional().describe('Filter by account owner'),
      sortBy: z.enum(['firstName', 'lastName', 'email', 'createdAt']).optional(),
      sortOrder: z.enum(['ASC', 'DESC']).optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    run: (client, args) =>
      client.request('GET', '/crm', { query: args, root: true }),
  },
  {
    name: 'get_contact',
    title: 'Get a contact',
    description:
      'Full contact record including linked appointments and form answers. Look it up by contactId, or by the attendeeId from an appointment — that is how you get from "who is on this booking" to "what do we know about them".',
    schema: {
      contactId: z.string().optional(),
      attendeeId: z
        .string()
        .optional()
        .describe('From get_appointment. Use when you only have the booking.'),
    },
    readOnly: true,
    // async so the guard rejects rather than throwing synchronously — the
    // declared return type is a promise and callers are entitled to treat it
    // as one.
    run: async (client, args) => {
      if (!args.contactId && !args.attendeeId) {
        throw new Error('Provide contactId or attendeeId')
      }
      return client.request('GET', '/crm/details', { query: args, root: true })
    },
  },
  {
    name: 'create_contact',
    title: 'Create a contact',
    description:
      'Create a CRM contact. Either email or phoneNumber is required. Search first — this does not deduplicate.',
    schema: {
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      phoneNumber: z.string().optional(),
      tags: z.array(z.string()).optional().describe('e.g. ["Lead", "Enterprise"]'),
      notes: z.string().optional().describe('Internal notes, not visible to the contact'),
      accountOwnerId: z.string().optional(),
    },
    readOnly: false,
    run: async (client, args) => {
      // The DTO enforces this server-side (EmailOrPhoneConstraint), but a 400
      // reads as "the tool is broken"; naming the missing field lets the agent
      // fix it in one turn.
      if (!args.email && !args.phoneNumber) {
        throw new Error('Provide either email or phoneNumber')
      }
      return client.request('POST', '/crm', { body: args, root: true })
    },
  },
  {
    name: 'update_contact',
    title: 'Update a contact',
    description:
      'Update a CRM contact. Only the fields you send change. Tags replace the existing list rather than merging, so read the contact first if you are adding one.',
    schema: {
      contactId: z.string(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      phoneNumber: z.string().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
      accountOwnerId: z.string().optional(),
    },
    readOnly: false,
    run: (client, { contactId, ...body }) =>
      client.request('PATCH', `/crm/${contactId}`, { body, root: true }),
  },
  {
    name: 'list_calendar_connections',
    title: 'List calendar connections',
    description:
      'List connected calendars (Google, Outlook, CalDAV). Use to check whether a host actually has a calendar attached before diagnosing why availability looks wrong.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/calendar-connections/connections'),
  },
]
