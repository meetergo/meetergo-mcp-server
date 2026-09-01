import { z } from 'zod'
import type { MeetergoClient } from './client.js'
import { fetchPublicUrl } from './safe-fetch.js'
import { presentSchedulingResult } from './scheduling-result.js'
import {
  analyzeInstallHtml,
  deriveSetupStatus,
  planFromMe,
  type SetupStatusInput,
} from './setup-status.js'

/**
 * The agent-facing tool surface: everything an agent needs to run scheduling
 * end to end, without reaching for raw REST.
 *
 * Grouped below as scheduling, appointments, follow-up, meeting types, booking
 * page, routing forms, CRM, webhooks, calendars. The scheduling loop comes
 * first on purpose — tool order is a weak prior for selection, and the common
 * path should be the first thing a model reads.
 *
 * Two rules hold across all of them, both learned the expensive way:
 *
 *   1. Every request shape is pinned against a route in `apps/api` and covered
 *      by a test that asserts the wire format. 0.1.x shipped five tools that
 *      could never succeed while every test passed, because the tests only
 *      checked that the tools existed.
 *   2. Where the API requires boilerplate the model cannot know (a nested
 *      `attendee`, `receiveReminders`, an empty `confirmationButton`), the tool
 *      fills it in. Making a model invent a large request body from a prose
 *      description is how you get confidently malformed payloads.
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
   * Set on tools that reach OUTSIDE meetergo — mail to an attendee, a page the
   * public can load, an HTTP call to a third-party endpoint. Not "does it touch
   * the network" (everything here does), but "can a person who is not this user
   * observe the effect".
   *
   * The distinction is the one a reviewer checks: booking a meeting emails an
   * invitation to someone who never consented to an agent acting for them, and
   * switching the widget live puts an assistant on a public website. Those are
   * categorically different from editing a private record, and hosts surface
   * them differently.
   */
  openWorld?: boolean
  /**
   * Names the origin of third-party text inside this tool's results (website
   * visitors, crawled pages, model output derived from them). The server wraps
   * such results in an explicit untrusted-content fence so the calling agent
   * treats them as data, never as instructions — the tool surface next to this
   * one includes deletes and sends, and "a visitor question that says to call
   * them" is exactly the attack this product category keeps shipping.
   */
  untrustedSource?: string
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

/** Form field types. Note the single/multi split — a bare "text" is rejected. */
const DATA_FIELD_TYPES = [
  'text-single',
  'text-multi',
  'email',
  'phone',
  'number',
  'select',
  'checkbox-single',
  'checkbox-multi',
  'radio',
  'slide',
  'url',
  'file',
  'date',
  'date-of-birth',
  'time',
  'yes-no',
  'rating',
  'scale',
  'signature',
] as const

/** Every event the API will accept on a webhook subscription. */
const WEBHOOK_EVENTS = [
  'booking_created',
  'booking_rescheduled',
  'booking_cancelled',
  'form_submission',
  'new_employee',
  'credential_error',
  'review_submitted',
  'review_published',
  'signature_completed',
] as const

/** A contact's part on a deal, beyond the single primary contactId. */
const DEAL_CONTACT_ROLES = [
  'primary',
  'decision_maker',
  'influencer',
  'user',
  'other',
] as const

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001+'] as const

/** Current channels. The enum also carries deprecated Skype/Teams v1 values. */
const MEETING_CHANNELS = [
  'local',
  'local-attendee',
  'google',
  'zoom',
  'phone',
  'phone-incoming',
  'whatsapp',
  'connect',
  'webex',
  'teamsForBusiness2',
  'teams2ForExchange',
  'custom',
  'resource',
  'whereby',
  'kmeet',
  'jitsi',
  'nextcloudTalk',
  'openTalk',
  'alfaview',
] as const

/**
 * Only fields the API actually keeps.
 *
 * Both meeting-type routes validate with `whitelist: true`, which silently
 * drops any property without a class-validator decorator — and six `MeetingInfo`
 * properties have none (`customChannelName`, `customChannelLink`,
 * `connectChannelName`, `groupBooking`, `enrichInvitee`, `confirmationButton`),
 * as do `slug` and `userId` on the create DTO. Offering them here would be a
 * lie: the request succeeds, the setting is discarded, and nobody finds out
 * until someone opens the booking page. They are configured in the dashboard.
 *
 * `description` is required on create — it carries `@IsString()` with no
 * `@IsOptional()` — which is why it is not optional below.
 */
const meetingInfoShape = {
  name: z.string().describe('Shown on the booking page'),
  description: z.string().describe('Shown on the booking page. Pass "" for none.'),
  duration: z
    .number()
    .int()
    .min(5)
    .max(480)
    .describe('Minutes, 5 to 480'),
  channel: z
    .enum(MEETING_CHANNELS)
    .describe('Where the meeting happens. "local" is at the host address.'),
  bufferBefore: z.number().int().min(0).max(120).optional().describe('Minutes, max 120'),
  bufferAfter: z.number().int().min(0).max(120).optional().describe('Minutes, max 120'),
  bufferMustStayWithinWorkingHours: z.boolean().optional(),
  showAvailableSlots: z.boolean().optional(),
  enableRedirect: z.boolean().optional(),
  redirect: z.string().optional().describe('URL to send attendees to after booking'),
  passEventDetailsToRedirect: z.boolean().optional(),
  color: z.string().optional().describe('Hex, e.g. #e55000'),
}

/**
 * A webhook target the API will POST to on every matching event, unattended.
 * `@IsUrl()` alone would accept `http://169.254.169.254/…`, turning an agent
 * that can be talked into creating a webhook into a request-forgery primitive.
 * Require TLS and a public host here; the same check belongs server-side.
 */
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return false
    }
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return !(
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      /^\[?::1\]?$/.test(host) ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  }, 'Must be an https URL on a public host')

/** Shared pagination for the list endpoints that use limit/offset. */
const listLimit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Max results, 1-100. Defaults to 50.')
const listOffset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('How many to skip. Defaults to 0.')

/** Drops keys the caller never set, so a patch stays a patch. */
function definedOnly(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined),
  )
}

/**
 * `webChat.publicKey` is server-minted and absent from the update DTO; the
 * API's forbidNonWhitelisted validation 400s any payload that carries it. It
 * shows up naturally when a snapshot from GET is played back, so every write
 * path strips it rather than asking the model to.
 */
function stripPublicKey(webChat: Record<string, unknown>): Record<string, unknown> {
  const { publicKey: _publicKey, ...rest } = webChat
  return rest
}

/**
 * The assistant-profile DTO requires every field, but half of them are
 * mechanical (`logoUrl: null`, empty avoid-instructions). Fill those so the
 * model only supplies what actually shapes behavior.
 */
function normalizeAssistantProfile(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  return {
    logoUrl: null,
    avoidInstructions: '',
    outOfHoursMessage: '',
    knowledgeSourceIds: [],
    bookingMeetingTypeId: null,
    routingFormId: null,
    openingHoursAvailabilityId: null,
    ...definedOnly(profile),
  }
}

/**
 * Reduce a full settings snapshot (from GET, which includes server-managed
 * state) to a body the update DTO accepts: keep only the DTO's top-level
 * fields, strip minted publicKeys, and drop the mirrored `channels.webChat`
 * list entirely — the controller regenerates it from `webChat`, and replaying
 * a stale mirror is the one path that could corrupt a rollback.
 */
export function sanitizeMiraSettingsForPatch(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of [
    'enabled',
    'activationPromptSeen',
    'customInstructions',
    'dataAccess',
    'webChat',
    'assistantProfiles',
    'channels',
    'dealAutopilot',
  ]) {
    if (snapshot[key] !== undefined) out[key] = snapshot[key]
  }
  if (out.webChat && typeof out.webChat === 'object') {
    out.webChat = stripPublicKey(out.webChat as Record<string, unknown>)
  }
  if (out.channels && typeof out.channels === 'object') {
    const { webChat: _mirror, ...restChannels } = out.channels as Record<
      string,
      unknown
    >
    if (Object.keys(restChannels).length) out.channels = restChannels
    else delete out.channels
  }
  return out
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
      'Return the authenticated account and, when available, its plan tier and relevant caps. This is a low-cost authentication check that distinguishes a bad token from an empty calendar. Plan data explains action-specific limits; it does not gate the connection itself.',
    schema: {},
    readOnly: true,
    run: async (client) => {
      const me = await client.request<Record<string, unknown>>(
        'GET',
        '/user/me',
      )
      const plan = planFromMe(me)
      return plan ? { ...me, plan } : me
    },
  },
  {
    name: 'list_meeting_types',
    title: 'List meeting types',
    description:
      "List the authenticated user's bookable meeting types, including the identifier, duration and host data required for a booking.",
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/meeting-type'),
  },
  {
    name: 'get_availability',
    title: 'Get available slots',
    description:
      "Return a meeting type's bookable starts within a date range. The slotsStartUtc values are the starts accepted by booking validation; calendar events alone are not availability.",
    schema: {
      meetingTypeId: z.string().describe('Meeting type identifier'),
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
          'Override the meeting type duration in minutes where the meeting type allows it. A booking for this result requires the same duration value.',
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
      const availability = await client.request(
        'GET',
        '/booking-availability',
        {
          query: { ...rest, ...scope },
        },
      )
      return presentSchedulingResult('availability', availability)
    },
  },
  {
    name: 'book_appointment',
    title: 'Book an appointment',
    description:
      'Create a real appointment for a start present in the meeting type availability results and send invitations. An unlisted start is rejected. A confirmed bookingState means the appointment exists; pending_confirmation means it is not booked yet. Either fullName or both firstName and lastName are required.',
    schema: {
      meetingTypeId: z.string(),
      start: iso.describe('Slot start returned by an availability query'),
      duration: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Length in minutes. Required only when the availability query used a duration override; otherwise the meeting type decides.',
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
    openWorld: true,
    destructive: true,
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

      const booking = await client.request('POST', '/booking', {
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
      return presentSchedulingResult('book', booking, {
        requestedStart: start,
      })
    },
  },
  {
    name: 'reschedule_appointment',
    title: 'Reschedule an appointment',
    description:
      'Move an appointment to a new start time. Duration is unchanged. Validates availability unless ignoreAvailability is set. A successful response echoes the new time as startUtc.',
    schema: {
      appointmentId: z.string(),
      start: iso.describe('New start time'),
      ignoreAvailability: z
        .boolean()
        .optional()
        .describe('Schedule outside available hours or over an existing booking'),
    },
    readOnly: false,
    openWorld: true,
    // Moves a real booking and notifies the attendees — the old slot is gone.
    destructive: true,
    run: async (client, { appointmentId, ...body }) => {
      const result = await client.request(
        'POST',
        `/appointment/${appointmentId}/reschedule`,
        {
          body,
        },
      )
      return presentSchedulingResult('reschedule', result, {
        requestedStart: body.start,
      })
    },
  },
  {
    name: 'cancel_appointment',
    title: 'Cancel an appointment',
    description:
      'Cancel an appointment and notify attendees. For a group booking, attendeeId removes one person while cancelAll cancels the whole appointment. Requests with neither are rejected. The response distinguishes attendee_removed from cancelled.',
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
    openWorld: true,
    destructive: true,
    run: async (client, { appointmentId, ...body }) => {
      const result = await client.request(
        'POST',
        `/appointment/${appointmentId}/cancel`,
        { body },
      )
      return presentSchedulingResult('cancel', result, {
        attendeeId: body.attendeeId,
      })
    },
  },
  {
    name: 'list_appointments',
    title: 'List appointments',
    description:
      'Return appointments with pagination and filters, including the appointmentId needed for changes. Every item carries a confirmed or cancelled status; cancelled items are not upcoming appointments. Pages are 0-indexed.',
    schema: {
      page: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-indexed page number. Defaults to 0.'),
      pageSize: z.number().int().min(1).max(100).optional(),
      start: iso.optional().describe('Only appointments starting at or after this'),
      end: z
        .string()
        .describe(
          'ISO 8601 timestamp. Only appointments starting at or before this.',
        )
        .optional(),
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
    run: async (client, { page, pageSize, ...rest }) => {
      const result = await client.request('GET', '/appointment/paginated', {
        query: { page: page ?? 0, pageSize: pageSize ?? 20, ...rest },
      })
      return presentSchedulingResult('appointment-list', result)
    },
  },
  {
    name: 'get_todays_appointments',
    title: "Get today's appointments",
    description:
      "Return today's appointments for the authenticated user. This specialised query is cheaper and more precise than a general date-filtered appointment list.",
    schema: {},
    readOnly: true,
    run: async (client) =>
      presentSchedulingResult(
        'today-appointments',
        await client.request('GET', '/appointment/today'),
      ),
  },
  {
    name: 'get_appointment',
    title: 'Get an appointment',
    description:
      'Return full detail for one appointment: status, attendees and their attendeeIds, hosts, location and notes. The attendeeIds support guest additions and per-attendee cancellation. The status indicates whether the booking is active.',
    schema: { appointmentId: z.string() },
    readOnly: true,
    run: async (client, { appointmentId }) =>
      presentSchedulingResult(
        'appointment',
        await client.request('GET', `/appointment/${appointmentId}`),
      ),
  },
  {
    name: 'add_guest',
    title: 'Add a guest to an appointment',
    description:
      'Add one guest email to an appointment so they receive the invitation and updates. Requires the attendeeId returned with appointment details and accepts one guest per call.',
    schema: {
      appointmentId: z.string(),
      attendeeId: z
        .string()
        .describe('The attendee identifier returned with appointment details'),
      email: z.string().email(),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { appointmentId, ...body }) =>
      client.request('PATCH', `/appointment/${appointmentId}/guest`, { body }),
  },
  {
    name: 'update_appointment_notes',
    title: 'Update appointment notes',
    description:
      'Replace the host-side note on an appointment with call preparation or an outcome summary. This is replacement rather than append, so retained existing text must be included in the new note.',
    schema: {
      appointmentId: z.string(),
      note: z.string(),
    },
    readOnly: false,
    // Replaces, not appends — whatever note was there is overwritten.
    destructive: true,
    run: (client, { appointmentId, note }) =>
      client.request('PATCH', `/appointment/${appointmentId}/notes`, {
        body: { note },
      }),
  },
  {
    name: 'create_one_time_booking_link',
    title: 'Create a one-time booking link',
    description:
      'Generate a single-use booking link for a meeting type so someone can choose their own slot. No attendee details are needed and the link cannot be reshared.',
    schema: { meetingTypeId: z.string() },
    readOnly: false,
    openWorld: true,
    run: (client, { meetingTypeId }) =>
      client.request('POST', `/one-time-booking-link/create/${meetingTypeId}`),
  },
  {
    name: 'search_contacts',
    title: 'Search CRM contacts',
    description:
      'Search the CRM by name, email, phone or tag. Results expose contactIds and support duplicate checks before contact creation.',
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
      'Return a full contact record including linked appointments and form answers. Accepts either a contactId or an attendeeId from an appointment and links booking identity to the stored contact.',
    schema: {
      contactId: z.string().optional(),
      attendeeId: z
        .string()
        .optional()
        .describe('Attendee identifier returned with appointment details'),
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
      'Create a CRM contact. Either email or phoneNumber is required. Existing contacts are not deduplicated.',
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
      'Update a CRM contact. Only supplied fields change. Tags replace the existing list rather than merging, so retained tags must be included.',
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
    // Tags replace rather than merge — a careless call silently drops data.
    destructive: true,
    run: (client, { contactId, ...body }) =>
      client.request('PATCH', `/crm/${contactId}`, { body, root: true }),
  },
  {
    name: 'list_calendar_connections',
    title: 'List calendar connections',
    description:
      'List connected calendars (Google, Outlook and CalDAV). The result shows whether a host has a calendar attached and supports availability diagnosis.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/calendar-connections/connections'),
  },

  // ---- Follow-up ----------------------------------------------------------
  {
    name: 'send_quick_email',
    title: 'Email an attendee',
    description:
      'Send a one-off email to an attendee, such as a follow-up, preparation note or directions. Requires an attendeeId from appointment details. Rate limited to 5 per 5 minutes.',
    schema: {
      attendeeId: z.string().describe('Attendee identifier from appointment details'),
      title: z.string().describe('Subject line'),
      content: z.string().describe('Body of the email'),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, body) =>
      client.request('POST', '/attendee/quick-mail', { body }),
  },
  {
    name: 'update_meeting_transcription',
    title: 'Store a transcript or summary',
    description:
      'Attach a meeting transcript and/or AI summary in markdown to an appointment. meetergo does not record calls, so the caller supplies the content. Only supplied fields change; null clears one.',
    schema: {
      appointmentId: z.string(),
      transcription: z
        .string()
        .nullable()
        .optional()
        .describe('Full transcript in markdown, or null to clear'),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe('Summary in markdown, or null to clear'),
    },
    readOnly: false,
    destructive: true,
    run: (client, { appointmentId, ...body }) =>
      client.request('PATCH', `/appointment/${appointmentId}/transcription`, {
        body,
      }),
  },

  // ---- Meeting types ------------------------------------------------------
  {
    name: 'get_meeting_type',
    title: 'Get a meeting type',
    description:
      'Return the full configuration of one meeting type: duration, channel, buffers, booking questions, reminders, host or queue. The result exposes the current values needed for a safe update.',
    schema: { meetingTypeId: z.string() },
    readOnly: true,
    run: (client, { meetingTypeId }) =>
      client.request('GET', `/meeting-type/${meetingTypeId}`),
  },
  {
    name: 'create_meeting_type',
    title: 'Create a meeting type',
    description:
      'Create a new meeting type owned by the authenticated user. It becomes a real, publicly bookable page immediately. The URL slug is generated from the name and remains editable.',
    schema: {
      ...meetingInfoShape,
      spots: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Attendees per slot, for a group booking'),
    },
    readOnly: false,
    openWorld: true,
    run: (client, { spots, ...info }) =>
      client.request('POST', '/meeting-type', {
        body: { meetingInfo: definedOnly(info), spots },
      }),
  },
  {
    name: 'update_meeting_type',
    title: 'Update a meeting type',
    description:
      'Change a meeting type. Only the fields you send change; everything you leave out keeps its current value.',
    schema: {
      meetingTypeId: z.string(),
      ...meetingInfoShape,
      // Everything is optional on a patch — the create-time requirements do
      // not apply, and UpdateMeetingInfoDto is fully partial.
      name: meetingInfoShape.name.optional(),
      description: meetingInfoShape.description.optional(),
      duration: meetingInfoShape.duration.optional(),
      channel: meetingInfoShape.channel.optional(),
      // Unlike the create DTO, slug is validated here, so it survives.
      slug: z.string().optional().describe('URL segment of the booking page'),
      spots: z.number().int().min(1).max(100).optional(),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { meetingTypeId, slug, spots, ...info }) => {
      const meetingInfo = definedOnly(info)
      return client.request('PATCH', `/meeting-type/${meetingTypeId}`, {
        // Omit meetingInfo entirely when only slug or spots changed, rather
        // than sending an empty object.
        body: {
          ...(Object.keys(meetingInfo).length ? { meetingInfo } : {}),
          slug,
          spots,
        },
      })
    },
  },
  {
    name: 'delete_meeting_type',
    title: 'Delete a meeting type',
    description:
      'Delete a meeting type. Its booking page stops working immediately. Existing appointments are not cancelled.',
    schema: { meetingTypeId: z.string() },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { meetingTypeId }) =>
      client.request('DELETE', `/meeting-type/${meetingTypeId}`),
  },

  // ---- Booking page -------------------------------------------------------
  {
    name: 'get_personal_page',
    title: 'Get the booking page',
    description:
      "The authenticated user's personal booking page: colours, header image, description, profile links, meeting-type order.",
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/personal-page/me'),
  },
  {
    name: 'update_personal_page',
    title: 'Update the booking page',
    description:
      'Change branding on the personal booking page. Only the fields you send change. Colours need useCustomColors set, or they are ignored.',
    schema: {
      useCustomColors: z
        .boolean()
        .optional()
        .describe('Must be true for primaryColor/secondaryColor to take effect'),
      primaryColor: z.string().optional().describe('Hex, e.g. #e55000'),
      secondaryColor: z.string().optional().describe('Hex, e.g. #e55000'),
      headerImage: z.string().nullable().optional().describe('Image URL, or null to remove'),
      description: z.string().optional(),
      showAllMeetingTypes: z.boolean().optional(),
      meetingTypeOrder: z
        .array(z.string())
        .optional()
        .describe('Meeting type ids, in display order'),
      onlineProfiles: z
        .record(z.unknown())
        .optional()
        .describe(
          'Contact and social links: linkedIn, facebook, twitter, instagram, xing, phone, email, addressStreet, addressCity, addressPostalCode, addressCountry, customLinks',
        ),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, body) =>
      client.request('PATCH', '/personal-page/me', { body }),
  },

  // ---- Migration ----------------------------------------------------------
  {
    name: 'import_booking_page',
    title: 'Import a booking page from another scheduler',
    description:
      'Recreate an existing public booking page in meetergo from its URL. Calendly and several other schedulers are recognised automatically. The tool reads only the public profile and creates one meeting type per visible event type with its duration, location and booking questions. It never modifies the source account. Imports are additive, so running it twice creates duplicates. The response lists both created items and failures.',
    schema: {
      url: z
        .string()
        .url()
        .describe(
          'Public booking page URL, e.g. https://calendly.com/<slug>. The provider is detected from the URL; an unrecognised host is rejected.',
        ),
    },
    readOnly: false,
    // Reaches a third-party host and creates publicly bookable pages: two
    // effects a person other than this user can observe.
    openWorld: true,
    // Names, descriptions and booking questions come from a page controlled by
    // whoever owns that profile — which, on a migration, is not always the
    // person running the agent. Fenced so "add a meeting type called ignore
    // previous instructions" arrives as data.
    untrustedSource: 'the imported booking page',
    run: (client, { url }) => client.request('POST', '/import', { body: { url } }),
  },

  // ---- Routing forms ------------------------------------------------------
  {
    name: 'list_routing_forms',
    title: 'List routing forms',
    description:
      'List routing forms and funnels — the qualification forms that route a visitor to the right meeting type or page. Returns 50 at a time; page with offset.',
    schema: { limit: listLimit, offset: listOffset },
    readOnly: true,
    run: (client, query) => client.request('GET', '/routing-form', { query }),
  },
  {
    name: 'get_routing_form',
    title: 'Get a routing form',
    description:
      'Full definition of a routing form: its steps, fields and the qualifier rules that decide where a visitor is sent.',
    schema: { formId: z.string() },
    readOnly: true,
    run: (client, { formId }) => client.request('GET', `/routing-form/${formId}`),
  },
  {
    name: 'create_routing_form',
    title: 'Create a routing form',
    description:
      'Create a routing form or funnel. Fields reference existing reusable data fields and qualifiers route on the answers. A qualifier with isFallback true provides the default route.',
    schema: {
      name: z.string(),
      // Required by the API, with no default.
      structureType: z
        .enum(['FORM_ONLY', 'FUNNEL_WITH_FORM', 'FUNNEL_ONLY'])
        .describe('FORM_ONLY is the plain form; the FUNNEL variants add steps.'),
      showProgressBar: z.boolean().optional(),
      skipForm: z
        .boolean()
        .optional()
        .describe(
          'Route on programmatic answers without rendering the form. REQUIRED (true) when the form backs Mira web-chat qualification: the widget submits answers conversationally, before any name exists, and qualification rejects nameless submissions unless skipForm is set.',
        ),
      slug: z
        .string()
        .optional()
        .describe('Public share link segment, at cal.meetergo.com/f/<slug>'),
      fields: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('Existing data fields to show: [{ dataFieldId, order }]'),
      funnelSteps: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('Steps, each with its own dataFields'),
      qualifiers: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          'Routing rules: { routingAction, meetingTypeId?, expression, isFallback? }. routingAction is one of eventRedirect, customPage, externalRedirect, contactForm, requestCallback, instantCall, formRedirect.',
        ),
    },
    readOnly: false,
    openWorld: true,
    run: (client, body) => client.request('POST', '/routing-form', { body }),
  },
  {
    name: 'update_routing_form',
    title: 'Update a routing form',
    description:
      'Update a routing form. Supplying qualifiers, fields or funnelSteps replaces each entire collection, so omitted items are deleted. Leaving those collections out changes only the name, slug or progress bar.',
    schema: {
      formId: z.string(),
      name: z.string().optional(),
      structureType: z
        .enum(['FORM_ONLY', 'FUNNEL_WITH_FORM', 'FUNNEL_ONLY'])
        .optional(),
      showProgressBar: z.boolean().optional(),
      skipForm: z
        .boolean()
        .optional()
        .describe(
          'Route on programmatic answers without rendering the form — required (true) for forms backing Mira web-chat qualification.',
        ),
      slug: z.string().optional(),
      fields: z.array(z.record(z.unknown())).optional(),
      funnelSteps: z.array(z.record(z.unknown())).optional(),
      qualifiers: z.array(z.record(z.unknown())).optional(),
    },
    readOnly: false,
    openWorld: true,
    // Declarative sync deletes whatever is left out, so this can quietly
    // dismantle a form's routing rules. Hosts should be able to confirm it.
    destructive: true,
    run: (client, { formId, ...body }) =>
      client.request('PATCH', `/routing-form/${formId}`, { body }),
  },
  {
    name: 'delete_routing_form',
    title: 'Delete a routing form',
    description:
      'Delete a routing form. Any link already shared stops working.',
    schema: { formId: z.string() },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { formId }) =>
      client.request('DELETE', `/routing-form/${formId}`),
  },
  {
    name: 'send_routing_form',
    title: 'Send a routing form',
    description:
      'Send a routing form to one recipient by email or SMS, or just mint the link. The response always carries publicUrl. Rate limited to 20 per minute.',
    schema: {
      formId: z.string(),
      recipientName: z.string(),
      deliveryMethod: z
        .enum(['email', 'sms', 'link'])
        .optional()
        .describe('Defaults to email. "link" only returns the URL.'),
      email: z.string().email().optional().describe('Required for email delivery'),
      phone: z.string().optional().describe('E.164, required for sms delivery'),
      message: z.string().optional().describe('Cover message'),
      contactId: z.string().optional().describe('Link the response to a CRM contact'),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { formId, ...body }) =>
      client.request('POST', `/routing-form/${formId}/send`, { body }),
  },
  {
    name: 'list_form_recipients',
    title: 'List form recipients',
    description:
      'List who a routing form was sent to, with sent, opened or completed status and timestamps. The result identifies recipients who have not answered.',
    schema: { formId: z.string() },
    readOnly: true,
    run: (client, { formId }) =>
      client.request('GET', `/routing-form/${formId}/recipients`),
  },
  {
    name: 'list_data_fields',
    title: 'List data fields',
    description:
      'List the reusable form fields shared across routing forms, including fields that may already match a planned addition. Returns 50 at a time with offset pagination.',
    schema: { limit: listLimit, offset: listOffset },
    readOnly: true,
    run: (client, query) => client.request('GET', '/data-field', { query }),
  },
  {
    name: 'create_data_field',
    title: 'Create a data field',
    description:
      'Create a reusable form field, company-wide. Choice fields need options; text fields do not.',
    schema: {
      label: z.string().describe('Shown to the person filling the form'),
      // The API enum distinguishes single from multi variants; a bare "text"
      // or "checkbox" is rejected.
      fieldType: z.enum(DATA_FIELD_TYPES),
      name: z.string().optional().describe('Internal key. Derived from the label if omitted.'),
      required: z.boolean().optional(),
      options: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('For choice fields: [{ label, value }]'),
      target: z
        .string()
        .optional()
        .describe('Maps the answer onto a known attendee field rather than a custom one'),
    },
    readOnly: false,
    run: (client, body) => client.request('POST', '/data-field', { body }),
  },

  // ---- CRM ----------------------------------------------------------------
  {
    name: 'bulk_create_contacts',
    title: 'Bulk-create contacts',
    description:
      'Create many contacts in one import. Each needs email or phoneNumber. A call accepts up to 1000 contacts and the endpoint is limited to 3 calls per minute.',
    schema: {
      contacts: z
        .array(
          z
            .object({
              firstName: z.string().optional(),
              lastName: z.string().optional(),
              email: z.string().email().optional(),
              phoneNumber: z.string().optional(),
              tags: z.array(z.string()).optional(),
              notes: z.string().optional(),
            })
            // The API's own email-or-phone constraint is skipped when email is
            // absent, so an empty row imports as a blank contact. Catch it here.
            .refine(
              (c) => Boolean(c.email || c.phoneNumber),
              'Each contact needs an email or a phoneNumber',
            ),
        )
        .min(1)
        .max(1000),
    },
    readOnly: false,
    run: (client, body) =>
      client.request('POST', '/crm/bulk', { body, root: true }),
  },
  {
    name: 'delete_contact',
    title: 'Delete a contact',
    description:
      'Permanently delete a CRM contact. Their past appointments remain, but the contact record and its form answers are gone.',
    schema: { contactId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { contactId }) =>
      client.request('DELETE', `/crm/${contactId}`, { root: true }),
  },

  // ---- Deals ----------------------------------------------------------------
  {
    name: 'list_pipelines',
    title: 'List pipelines',
    description:
      'List sales pipelines and their stages, each with an id, order, colour and whether it counts as won or lost. A valid stageId from here is required to create or move a deal.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/crm/pipelines', { root: true }),
  },
  {
    name: 'list_deals',
    title: 'List deals',
    description:
      'Search and filter deals by pipeline, stage, contact, company, owner or a name match. isOpen, isWon and isLost filter by outcome; paginated with page and limit.',
    schema: {
      search: z.string().optional().describe('Matches the deal name'),
      pipelineId: z.string().optional(),
      stageId: z.string().optional(),
      ownerId: z.string().optional(),
      contactId: z.string().optional(),
      crmCompanyId: z.string().optional(),
      isOpen: z.boolean().optional(),
      isWon: z.boolean().optional(),
      isLost: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).optional(),
      sortBy: z.string().optional(),
      sortOrder: z.enum(['ASC', 'DESC']).optional(),
    },
    readOnly: true,
    run: (client, args) =>
      client.request('GET', '/crm/deals', { query: args, root: true }),
  },
  {
    name: 'get_deal',
    title: 'Get a deal',
    description:
      'Return a full deal record, including its linked contact, company, stage and owner.',
    schema: { dealId: z.string() },
    readOnly: true,
    run: (client, { dealId }) =>
      client.request('GET', `/crm/deals/${dealId}`, { root: true }),
  },
  {
    name: 'create_deal',
    title: 'Create a deal',
    description:
      'Create a deal in a pipeline. Requires a name, pipelineId and a stageId that belongs to that pipeline — read the pipelines first to find valid ids. Optionally links a contact, a company and an owner.',
    schema: {
      name: z.string().max(255),
      pipelineId: z.string(),
      stageId: z.string().describe('Must belong to pipelineId'),
      value: z.number().optional(),
      currency: z.string().max(10).optional().describe('e.g. EUR, USD'),
      expectedCloseDate: z.string().optional().describe('ISO 8601 date'),
      notes: z.string().max(10000).optional(),
      crmCompanyId: z.string().optional(),
      contactId: z.string().optional(),
      ownerId: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Account owner. Omit to default to the creating user; pass null to create the deal with no owner at all.',
        ),
      contacts: z
        .array(
          z.object({
            contactId: z.string(),
            role: z.enum(DEAL_CONTACT_ROLES).optional(),
            isPrimary: z.boolean().optional(),
          }),
        )
        .optional()
        .describe('Contacts on the deal beyond contactId, each with a role'),
      customFields: z.record(z.unknown()).optional(),
    },
    readOnly: false,
    run: (client, body) =>
      client.request('POST', '/crm/deals', { body, root: true }),
  },
  {
    name: 'update_deal',
    title: 'Update a deal',
    description:
      'Change a deal. Only supplied fields change. Passing null for contactId, crmCompanyId, expectedCloseDate or ownerId clears that field. Move the deal to another stage in its own pipeline with stageId.',
    schema: {
      dealId: z.string(),
      name: z.string().max(255).optional(),
      value: z.number().optional(),
      currency: z.string().max(10).optional(),
      expectedCloseDate: z.string().nullable().optional(),
      notes: z.string().max(10000).optional(),
      crmCompanyId: z.string().nullable().optional(),
      contactId: z.string().nullable().optional(),
      stageId: z.string().optional(),
      ownerId: z
        .string()
        .nullable()
        .optional()
        .describe('null clears the account owner, leaving the deal unassigned'),
      customFields: z.record(z.unknown()).optional(),
    },
    readOnly: false,
    run: (client, { dealId, ...body }) =>
      client.request('PATCH', `/crm/deals/${dealId}`, { body, root: true }),
  },
  {
    name: 'delete_deal',
    title: 'Delete a deal',
    description:
      'Permanently delete a deal. Its activity history and stage changes are gone with it.',
    schema: { dealId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { dealId }) =>
      client.request('DELETE', `/crm/deals/${dealId}`, { root: true }),
  },
  {
    name: 'mark_deal_won',
    title: 'Mark a deal as won',
    description:
      "Close a deal as won and move it to a won-flagged stage in its pipeline. Pass wonStageId to pick a specific one when the pipeline has more than one; omit it to use the pipeline's default.",
    schema: {
      dealId: z.string(),
      wonStageId: z
        .string()
        .optional()
        .describe('A stage in the deal’s own pipeline with isWon set'),
    },
    readOnly: false,
    run: (client, { dealId, ...body }) =>
      client.request('PATCH', `/crm/deals/${dealId}/won`, { body, root: true }),
  },
  {
    name: 'mark_deal_lost',
    title: 'Mark a deal as lost',
    description:
      'Close a deal as lost. lostReason is a free-form key rather than a fixed list, since each company configures its own reasons; whether one is required is a per-company setting.',
    schema: {
      dealId: z.string(),
      lostReason: z.string().max(64).optional(),
      lostReasonNote: z.string().max(1000).optional(),
      lostStageId: z
        .string()
        .optional()
        .describe('A stage in the deal’s own pipeline with isLost set'),
    },
    readOnly: false,
    run: (client, { dealId, ...body }) =>
      client.request('PATCH', `/crm/deals/${dealId}/lost`, { body, root: true }),
  },
  {
    name: 'reopen_deal',
    title: 'Reopen a deal',
    description:
      'Reopen a deal previously closed as won or lost, clearing that outcome. Pass stageId to land it on a specific stage in its pipeline; omit it to use the default for reopened deals.',
    schema: {
      dealId: z.string(),
      stageId: z.string().optional(),
    },
    readOnly: false,
    run: (client, { dealId, ...body }) =>
      client.request('PATCH', `/crm/deals/${dealId}/reopen`, {
        body,
        root: true,
      }),
  },
  {
    name: 'get_deal_activity',
    title: "Get a deal's activity log",
    description:
      'Return the stage-change and field-update history for a deal, most recent first. Read-only: entries are written by the API itself, not by a tool call.',
    schema: {
      dealId: z.string(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max entries. Defaults to 50.'),
    },
    readOnly: true,
    run: (client, { dealId, limit }) =>
      client.request('GET', `/crm/deals/${dealId}/activity`, {
        query: { limit: limit ?? 50 },
        root: true,
      }),
  },

  // ---- Companies ------------------------------------------------------------
  {
    name: 'list_companies',
    title: 'List companies',
    description:
      'Search and filter CRM companies by name, industry, size or owner; paginated with page and limit.',
    schema: {
      search: z.string().optional().describe('Matches the company name'),
      industry: z.string().optional(),
      size: z.enum(COMPANY_SIZES).optional(),
      ownerId: z.string().optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).optional(),
      sortBy: z.string().optional(),
      sortOrder: z.enum(['ASC', 'DESC']).optional(),
    },
    readOnly: true,
    run: (client, args) =>
      client.request('GET', '/crm/companies', { query: args, root: true }),
  },
  {
    name: 'get_company',
    title: 'Get a company',
    description: 'Return a full CRM company record, including its owner and deal/contact counts.',
    schema: { crmCompanyId: z.string() },
    readOnly: true,
    run: (client, { crmCompanyId }) =>
      client.request('GET', `/crm/companies/${crmCompanyId}`, { root: true }),
  },
  {
    name: 'create_company',
    title: 'Create a company',
    description:
      'Create a CRM company. Only name is required; link it to contacts and deals afterwards via their crmCompanyId.',
    schema: {
      name: z.string().max(255),
      domain: z.string().max(255).optional(),
      industry: z.string().max(100).optional(),
      size: z.enum(COMPANY_SIZES).optional(),
      website: z.string().max(500).optional(),
      phoneNumber: z.string().max(50).optional(),
      addressLine1: z.string().max(255).optional(),
      addressLine2: z.string().max(255).optional(),
      addressCity: z.string().max(100).optional(),
      addressZip: z.string().max(20).optional(),
      addressCountry: z.string().max(100).optional(),
      notes: z.string().max(10000).optional(),
      ownerId: z.string().optional(),
      customFields: z
        .record(z.unknown())
        .optional()
        .describe('Keyed by field key from list_data_fields'),
    },
    readOnly: false,
    run: (client, body) =>
      client.request('POST', '/crm/companies', { body, root: true }),
  },
  {
    name: 'update_company',
    title: 'Update a company',
    description:
      'Update an existing company. All fields optional; only supplied fields change. Pass ownerId: null to remove the owner. customFields is a patch: a key sent as null is removed, keys left out are untouched.',
    schema: {
      crmCompanyId: z.string(),
      name: z.string().max(255).optional(),
      domain: z.string().max(255).optional(),
      industry: z.string().max(100).optional(),
      size: z.enum(COMPANY_SIZES).optional(),
      website: z.string().max(500).optional(),
      phoneNumber: z.string().max(50).optional(),
      addressLine1: z.string().max(255).optional(),
      addressLine2: z.string().max(255).optional(),
      addressCity: z.string().max(100).optional(),
      addressZip: z.string().max(20).optional(),
      addressCountry: z.string().max(100).optional(),
      notes: z.string().max(10000).optional(),
      ownerId: z.string().nullable().optional(),
      customFields: z
        .record(z.unknown().nullable())
        .optional()
        .describe('Keyed by field key from list_data_fields; null removes a key'),
    },
    readOnly: false,
    run: (client, { crmCompanyId, ...body }) =>
      client.request('PATCH', `/crm/companies/${crmCompanyId}`, { body, root: true }),
  },
  {
    name: 'delete_company',
    title: 'Delete a company',
    description:
      'Permanently delete a CRM company. Contacts and deals that referenced it keep existing but lose the link.',
    schema: { crmCompanyId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { crmCompanyId }) =>
      client.request('DELETE', `/crm/companies/${crmCompanyId}`, { root: true }),
  },
  {
    name: 'get_company_by_domain',
    title: 'Find a company by domain',
    description: 'Look up a CRM company by its website domain, e.g. for de-duplication before creating a new one.',
    schema: { domain: z.string() },
    readOnly: true,
    run: (client, { domain }) =>
      client.request('GET', `/crm/companies/by-domain/${domain}`, { root: true }),
  },
  {
    name: 'get_company_contacts',
    title: "Get a company's contacts",
    description: 'List the CRM contacts linked to a company.',
    schema: { crmCompanyId: z.string() },
    readOnly: true,
    run: (client, { crmCompanyId }) =>
      client.request('GET', `/crm/companies/${crmCompanyId}/contacts`, { root: true }),
  },
  {
    name: 'get_company_deals',
    title: "Get a company's deals",
    description: 'List the deals linked to a company, across every pipeline.',
    schema: { crmCompanyId: z.string() },
    readOnly: true,
    run: (client, { crmCompanyId }) =>
      client.request('GET', `/crm/companies/${crmCompanyId}/deals`, { root: true }),
  },
  {
    name: 'get_company_summary',
    title: 'Get company summary',
    description:
      'Aggregate CRM company counts and pipeline value, grouped by industry and by size band. Optionally scoped to one owner.',
    schema: { ownerId: z.string().optional() },
    readOnly: true,
    run: (client, args) =>
      client.request('GET', '/crm/companies/summary', { query: args, root: true }),
  },

  // ---- Webhooks -----------------------------------------------------------
  {
    name: 'list_webhooks',
    title: 'List webhooks',
    description:
      'List webhook endpoints for the company. The result shows current subscriptions against the maximum of six endpoints.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/webhooks', { root: true }),
  },
  {
    name: 'create_webhook',
    title: 'Create a webhook',
    description:
      'Register an HTTPS endpoint to receive events. Six per company maximum; the API says so plainly when you hit it.',
    schema: {
      endpoint: httpsUrl.describe('HTTPS URL that will receive POSTs'),
      eventTypes: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
      description: z.string().optional().describe('Label, for your own reference'),
    },
    readOnly: false,
    openWorld: true,
    run: (client, body) =>
      client.request('POST', '/webhooks', { body, root: true }),
  },
  {
    name: 'update_webhook',
    title: 'Update a webhook',
    description:
      'Change a webhook endpoint, its description, or which events it receives. eventTypes replaces the existing list.',
    schema: {
      webhookId: z.string(),
      endpoint: httpsUrl.optional(),
      eventTypes: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
      description: z.string().optional(),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { webhookId, ...body }) =>
      client.request('PATCH', `/webhooks/${webhookId}`, { body, root: true }),
  },
  {
    name: 'delete_webhook',
    title: 'Delete a webhook',
    description:
      'Delete a webhook endpoint. Whatever depends on those events stops receiving them immediately.',
    schema: { webhookId: z.string() },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { webhookId }) =>
      client.request('DELETE', `/webhooks/${webhookId}`, { root: true }),
  },

  // ---- Mira & website knowledge -------------------------------------------
  {
    name: 'get_mira_settings',
    title: 'Get Mira settings',
    description:
      "Return the company's resolved Mira configuration: master switch, assistant profiles, website chat widget including its server-minted publicKey, and data-access toggles. The result is suitable as a rollback snapshot.",
    schema: {},
    readOnly: true,
    run: (client) =>
      client.request('GET', '/company/mira-settings', { root: true }),
  },
  {
    name: 'update_mira_settings',
    title: 'Update Mira settings',
    description:
      'Partially update Mira configuration (admin only). Omitted fields keep their current value; webChat merges field-by-field and assistantProfiles replaces the whole list. Saving any webChat field mints the widget publicKey even while enabled stays false, creating a previewable draft state. The response includes previous and current settings for rollback. The API rejects unknown fields.',
    schema: {
      enabled: z
        .boolean()
        .optional()
        .describe('Company-wide Mira master switch'),
      customInstructions: z
        .string()
        .max(2000)
        .optional()
        .describe('Company-wide instructions for the dashboard assistant'),
      dataAccess: z
        .object({})
        .passthrough()
        .optional()
        .describe(
          'Per-category toggles: meetingTypes, appointments, workflows, forms, files, contacts, companies, deals — each boolean',
        ),
      webChat: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe(
              'Widget live on customer websites. Keep false while drafting; the preview page works with a disabled widget.',
            ),
          assistantName: z.string().max(60).optional(),
          welcomeMessage: z.string().max(280).optional(),
          customPrompt: z
            .string()
            .max(4000)
            .optional()
            .describe('Appended to the system prompt — behavior instructions'),
          qualify: z
            .boolean()
            .optional()
            .describe('Ask the routing form questions before offering slots'),
          routingFormId: z.string().max(64).nullable().optional(),
          bookingMeetingTypeId: z
            .string()
            .max(64)
            .nullable()
            .optional()
            .describe('Meeting type Mira books inside the conversation'),
          useKnowledge: z
            .boolean()
            .optional()
            .describe('Answer from the crawled/ingested company knowledge base'),
          aiDisclosure: z
            .boolean()
            .optional()
            .describe('Tell visitors they are talking to an AI'),
          privacyPolicyUrl: z
            .string()
            .max(2048)
            .nullable()
            .optional()
            .describe(
              'Full URL with protocol. Lead capture stays off until this is set.',
            ),
          imprintUrl: z.string().max(2048).nullable().optional(),
          allowedDomains: z
            .array(z.string().max(255))
            .optional()
            .describe(
              'Bare hostnames allowed to embed the widget, e.g. ["example.com"]. Empty = any origin outside production.',
            ),
          accentColor: z.string().optional().describe('Hex, e.g. #1a2b3c'),
          defaultLanguage: z.enum(['de', 'en']).optional(),
          quickActions: z.array(z.string().max(80)).max(6).optional(),
          humanHandoff: z.boolean().optional(),
          greetingEnabled: z.boolean().optional(),
          greetingMessage: z.string().max(140).optional(),
        })
        .passthrough()
        .optional(),
      assistantProfiles: z
        .array(
          z
            .object({
              id: z.string().max(64),
              name: z.string().max(80),
              welcomeMessage: z.string().max(280),
              purpose: z.enum(['sales', 'support', 'booking', 'reception']),
              tone: z.enum([
                'friendly',
                'professional',
                'short',
                'formal',
                'concierge',
              ]),
              instructions: z.string().max(4000),
              capabilities: z.array(
                z.enum([
                  'knowledge',
                  'qualify',
                  'booking',
                  'contactDetails',
                  'summaries',
                  'handoff',
                ]),
              ),
              boundaries: z.array(
                z.enum([
                  'confidence',
                  'human',
                  'businessHours',
                  'sensitive',
                  'whatsappWindow',
                ]),
              ),
              avoidInstructions: z.string().max(2000).optional(),
              outOfHoursMessage: z.string().max(500).optional(),
              bookingMeetingTypeId: z.string().max(64).nullable().optional(),
              routingFormId: z.string().max(64).nullable().optional(),
            })
            .passthrough(),
        )
        .max(20)
        .optional()
        .describe(
          'REPLACES the whole list. Include every profile that should exist afterwards.',
        ),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: async (client, args) => {
      const previous = await client.request<Record<string, unknown>>(
        'GET',
        '/company/mira-settings',
        { root: true },
      )
      const body = definedOnly({
        enabled: args.enabled,
        customInstructions: args.customInstructions,
        dataAccess: args.dataAccess,
        webChat: args.webChat ? stripPublicKey(args.webChat) : undefined,
        assistantProfiles: Array.isArray(args.assistantProfiles)
          ? args.assistantProfiles.map(normalizeAssistantProfile)
          : undefined,
      })
      const current = await client.request('PATCH', '/company/mira-settings', {
        body,
        root: true,
      })
      return { previous, current }
    },
  },
  {
    name: 'restore_mira_settings',
    title: 'Restore Mira settings from a snapshot',
    description:
      'Roll Mira configuration back to a previously returned settings snapshot. Server-managed fields such as publicKey and the mirrored channels.webChat list are stripped automatically. The minted publicKey survives a rollback and remains harmless while the widget is disabled.',
    schema: {
      settings: z
        .record(z.unknown())
        .describe(
          'The full settings snapshot to restore. Pass it back unmodified.',
        ),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { settings }) =>
      client.request('PATCH', '/company/mira-settings', {
        body: sanitizeMiraSettingsForPatch(settings),
        root: true,
      }),
  },
  {
    name: 'get_mira_widget_embed',
    title: 'Get the Mira widget install snippet',
    description:
      'Return the embed snippet a website owner pastes before </body>, plus the preview URL for testing a saved-but-disabled widget. Requires the webChat publicKey minted when widget configuration is first saved.',
    schema: {},
    readOnly: true,
    run: async (client) => {
      const settings = await client.request<{
        webChat?: { publicKey?: string; enabled?: boolean; allowedDomains?: string[] }
      }>('GET', '/company/mira-settings', { root: true })
      const publicKey = settings?.webChat?.publicKey
      if (!publicKey)
        throw new Error(
          'No widget publicKey exists yet. Call update_mira_settings with any webChat field first — that mints the key without enabling anything.',
        )
      const loaderUrl = `${client.nextUrl}/mira-widget.js`
      return {
        publicKey,
        enabled: settings?.webChat?.enabled ?? false,
        allowedDomains: settings?.webChat?.allowedDomains ?? [],
        loaderUrl,
        snippet: `<script\n  src="${loaderUrl}"\n  data-mira-key="${publicKey}"\n  async\n></script>`,
        widgetPageUrl: `${client.nextUrl}/mira-widget?key=${publicKey}`,
        previewUrl: `${client.nextUrl}/mira-widget?key=${publicKey}&preview=1`,
      }
    },
  },
  {
    name: 'crawl_company_website',
    title: 'Crawl a website into the knowledge base',
    description:
      "Start a background crawl of a website into the company's Mira knowledge base, covering its sitemap and same-origin links while extracting, chunking and embedding readable text. Crawl progress remains available through status reads. Re-crawling an unchanged site ingests 0 new pages and is still successful. Requires the file-uploads entitlement (Growth and up).",
    schema: {
      url: z
        .string()
        .url()
        .describe('Start URL, e.g. the site root. Same-origin pages only.'),
      maxPages: z.number().int().min(1).max(100).optional(),
      language: z
        .string()
        .length(2)
        .optional()
        .describe('Keep only pages in this 2-letter language, e.g. "de"'),
    },
    readOnly: false,
    openWorld: true,
    run: (client, body) =>
      client.request('POST', '/knowledge/crawl', {
        body: definedOnly(body),
        root: true,
      }),
  },
  {
    name: 'get_crawl_status',
    title: 'Get website crawl status',
    description:
      'Progress of the current or last knowledge-base website crawl. { status: "idle" } means none has run yet.',
    schema: {},
    readOnly: true,
    run: (client) =>
      client.request('GET', '/knowledge/crawl/status', { root: true }),
  },
  {
    name: 'list_knowledge_documents',
    title: 'List knowledge documents',
    description:
      "Documents in the company's Mira knowledge base — crawled pages, uploaded files, synced sources — with their source keys.",
    schema: {},
    readOnly: true,
    run: (client) =>
      client.request('GET', '/knowledge/documents', { root: true }),
  },
  {
    name: 'delete_knowledge_document',
    title: 'Delete a knowledge document',
    description:
      'Remove one document (and its chunks) from the knowledge base. Mira stops answering from it immediately.',
    schema: { documentId: z.string() },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, { documentId }) =>
      client.request('DELETE', `/knowledge/documents/${documentId}`, {
        root: true,
      }),
  },
  {
    name: 'propose_conversion_setup',
    title: 'Propose a Mira setup from a website',
    description:
      "Read a sample of a website and propose a complete assistant setup: persona, welcome message, grounded instructions, qualification questions, quick actions, the site's own privacy and imprint links, and a knowledge probe. The result is a settings draft; nothing is stored or configured. Takes up to a minute.",
    schema: {
      url: z.string().url().describe("The website to analyse, e.g. the customer's homepage"),
      useCase: z
        .enum(['sales', 'support', 'booking', 'reception'])
        .optional()
        .describe(
          'What the assistant is FOR. Changes the brief it is designed against, not just its wording. Defaults to sales.',
        ),
      language: z
        .string()
        .length(2)
        .optional()
        .describe('Restrict the pages read to this 2-letter language, e.g. "de"'),
    },
    readOnly: true,
    untrustedSource: 'the analysed website',
    run: (client, body) =>
      client.request('POST', '/knowledge/conversion-proposal', {
        body: definedOnly(body),
        root: true,
        // Crawls a site and runs a model over it — the endpoint legitimately
        // takes longer than the default request budget.
        timeoutMs: 150_000,
      }),
  },
  {
    name: 'answer_visitor_question',
    title: 'Teach the assistant an answer',
    description:
      "Add a question-and-answer pair to the company's knowledge base in the company's own words. This closes a visitor knowledge gap. Repeating the same question replaces the earlier answer rather than creating two versions.",
    schema: {
      question: z.string().max(300).describe('The question, as a visitor would ask it'),
      answer: z.string().max(5000).describe("The company's answer, verbatim"),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, body) =>
      client.request('POST', '/knowledge/answer', { body, root: true }),
  },
  {
    name: 'get_conversation_insights',
    title: 'Website chat insights',
    description:
      'Summarise recent website assistant activity and the visitor questions it could not answer. Unanswered questions identify gaps suitable for new knowledge entries.',
    schema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe('Window in days, 1-90. Defaults to 7.'),
    },
    readOnly: true,
    untrustedSource: 'website visitors',
    run: (client, { days }) =>
      client.request('GET', '/web-chat/insights', {
        query: definedOnly({ days }),
        root: true,
      }),
  },
  {
    name: 'search_company_knowledge',
    title: 'Search the company knowledge base',
    description:
      'Semantically search the knowledge base using the same retrieval Mira uses for visitor answers. The results validate grounded coverage for a question before launch.',
    schema: {
      query: z.string().min(1),
      k: z.number().int().min(1).max(10).optional().describe('Chunks to return, default 5'),
    },
    readOnly: true,
    untrustedSource: 'crawled website pages',
    run: (client, body) =>
      client.request('POST', '/knowledge/search', {
        body: definedOnly(body),
        root: true,
      }),
  },
  {
    name: 'get_setup_status',
    title: 'Where this account stands on the way to live',
    description:
      'Return the dashboard launch checklist for bookable meeting type, assistant, knowledge, test drive, installation and live state. Each stage includes completion status and the concrete next move, making the result suitable before or after setup changes.',
    schema: {},
    readOnly: true,
    run: async (client) => {
      const settings = await client.request<SetupStatusInput['settings']>(
        'GET',
        '/company/mira-settings',
        { root: true },
      )
      // Both counts are entitlement-gated or empty on fresh accounts; a
      // failure to read them means "none yet", not a broken checklist.
      const [documents, meetingTypes] = await Promise.all([
        client
          .request<{ documents?: unknown[] }>('GET', '/knowledge/documents', {
            root: true,
          })
          .catch(() => ({ documents: [] as unknown[] })),
        client
          .request<unknown[]>('GET', '/meeting-type')
          .catch(() => [] as unknown[]),
      ])
      return deriveSetupStatus({
        settings: settings ?? {},
        knowledgeDocumentCount: documents?.documents?.length ?? 0,
        meetingTypeCount: Array.isArray(meetingTypes) ? meetingTypes.length : 0,
      })
    },
  },
  {
    name: 'create_qualification_form',
    title: 'Turn qualification questions into a routing form',
    description:
      "Create a real routing form from supplied qualification questions, with structured fields the company can edit and a fallback rule routing qualified visitors into a meeting type or callback. The returned formId is suitable for a qualifying web chat profile.",
    schema: {
      assistantName: z
        .string()
        .max(60)
        .describe('Names the form recognisably, e.g. "Qualification – Lena"'),
      language: z
        .string()
        .length(2)
        .optional()
        .describe('Form title language, "de" or "en". Defaults to en.'),
      meetingTypeId: z
        .string()
        .optional()
        .describe(
          'Where qualified visitors book. Omit to route them to a callback instead.',
        ),
      questions: z
        .array(
          z.object({
            label: z.string().max(200).describe('The question, as asked'),
            key: z
              .string()
              .max(80)
              .describe('Stable answer key, e.g. "team_size"'),
            options: z
              .array(z.string().max(120))
              .describe('Choice options; empty for a free-text question'),
          }),
        )
        .min(1)
        .max(10),
    },
    readOnly: false,
    openWorld: true,
    run: (client, body) =>
      client.request('POST', '/knowledge/qualification-form', {
        body: definedOnly(body),
        root: true,
      }),
  },
  {
    name: 'run_test_drive',
    title: 'Prove the assistant works (scripted visitors)',
    description:
      'Send scripted visitors to the saved assistant, including a buyer, a callback lead and an adversarial visitor, then return pass/fail verdicts with full transcripts. Preview mode creates no bookings or emails and does not require a live widget. The stored result feeds the launch checklist. Takes about a minute and is rate-limited to a few runs per hour.',
    schema: {},
    // Not readOnly: the verdict is persisted (it is what get_setup_status
    // reports as the test-drive step), and each call spends real model budget.
    // A host that wants to confirm expensive calls with the human should get
    // the chance to.
    readOnly: false,
    untrustedSource: 'simulated visitor conversations',
    run: async (client) => {
      const settings = await client.request<{
        webChat?: { publicKey?: string }
      }>('GET', '/company/mira-settings', { root: true })
      const publicKey = settings?.webChat?.publicKey
      if (!publicKey)
        throw new Error(
          'No widget exists yet — call update_mira_settings with any webChat field first; that mints the key without enabling anything.',
        )
      // The suite runs on the widget host (apps/next), not the API — it drives
      // the real chat route. Several LLM conversations end to end, so the
      // budget is deliberately generous.
      const response = await fetch(`${client.nextUrl}/api/mira-widget/testdrive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: publicKey }),
        signal: AbortSignal.timeout(180_000),
      })
      if (response.status === 429)
        throw new Error(
          'The test drive is rate-limited to a few runs per hour and this hour’s budget is used up. Try again later — the saved configuration is unaffected.',
        )
      if (!response.ok)
        throw new Error(`test drive failed (${response.status})`)
      return (await response.json()) as unknown
    },
  },
  {
    name: 'verify_widget_install',
    title: 'Verify the widget is live on a website',
    description:
      "Fetch a page of the customer's website and verify that it serves both the Mira loader script and the customer's own embed key. Intended after the snippet is installed; installed is true only when both elements are present.",
    schema: {
      url: z
        .string()
        .url()
        .describe('The page to check, e.g. https://example.com'),
    },
    readOnly: true,
    run: async (client, { url }) => {
      const settings = await client.request<{
        webChat?: { publicKey?: string }
      }>('GET', '/company/mira-settings', { root: true })
      const publicKey = settings?.webChat?.publicKey ?? null
      // fetchPublicUrl resolves the hostname itself and refuses anything
      // non-public, per redirect hop — this tool takes an arbitrary URL from
      // whatever the agent read, and it runs both on our pod and on the
      // user's machine. Neither may be turned into a proxy to localhost,
      // cloud metadata, or an intranet.
      const response = await fetchPublicUrl(url, {
        timeoutMs: 20_000,
        // The snippet sits in the document HTML; a page bigger than this has
        // other problems. Streamed with a hard stop, not buffer-then-slice.
        maxBytes: 2_000_000,
        userAgent: 'meetergo-mcp-install-check',
      })
      if (!response.ok)
        return {
          installed: false,
          checkedUrl: response.url,
          error: `The page answered ${response.status} — check the URL is public.`,
        }
      const check = analyzeInstallHtml(response.body, publicKey)
      return {
        ...check,
        checkedUrl: response.url,
        hint: check.installed
          ? undefined
          : check.foundLoader
            ? 'The loader script is there but with a different embed key — probably a snippet from another account or an old key. Re-paste the snippet from get_mira_widget_embed.'
            : 'No widget script found in the page HTML. If the site builder injects scripts client-side (e.g. some tag managers), the widget may still work — otherwise paste the snippet from get_mira_widget_embed before </body>.',
      }
    },
  },
]
