import { z } from 'zod'
import type { MeetergoClient } from './client.js'
import { fetchPublicUrl } from './safe-fetch.js'
import { presentSchedulingResult } from './scheduling-result.js'
import { definedOnly, iso, listLimit, listOffset } from './tool-helpers.js'
import { DOCS_TOOLS } from './tools-docs.js'
import { AVAILABILITY_TOOLS } from './tools-availability.js'
import { SPACES_TOOLS } from './tools-spaces.js'
import { ENGAGEMENT_TOOLS } from './tools-engagement.js'
import { BOOKING_SETUP_TOOLS } from './tools-booking-setup.js'
import { INVOICING_TOOLS } from './tools-invoicing.js'
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
  'image',
  'heading',
  'separator',
  'page-break',
  'contact',
  'bank-details',
  'license-plate',
  'info-text',
  'info-image',
  'info-video',
  'currency',
  'location',
  'pdf-template',
  'signature-document',
  'file-download',
  'testimonial',
  'faq',
  'countdown',
  'loading',
  'quiz-reveal',
  'logos',
  'checklist',
  'html',
  'address',
  'searchable-choice',
] as const

/** Which attendee field a data field's answer maps onto (`other` = custom). */
const DATA_FIELD_TARGETS = [
  'email',
  'firstname',
  'lastname',
  'fullname',
  'phone',
  'marketing_consent',
  'linkedin_profile',
  'other',
] as const

/** Booking form language of the attendee. */
const ATTENDEE_LANGUAGES = [
  'en', 'de', 'fr', 'es', 'no', 'nl', 'it', 'pl', 'se', 'tr', 'da', 'pt', 'ru', 'uk',
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

/** What entering a pipeline stage records for the Sales Learning report. */
const SALES_MILESTONES = ['start', 'demo', 'offer'] as const

/** Optional data-field settings shared by create and update. */
const dataFieldExtraShape = {
  hidden: z.boolean().optional(),
  placeholder: z.string().optional(),
  helpText: z.string().optional().describe('Shown below the field in the booking form'),
  defaultValue: z.string().nullable().optional(),
  min: z.number().optional().describe('Number fields: minimum'),
  max: z.number().optional().describe('Number fields: maximum'),
  locales: z
    .array(z.record(z.unknown()))
    .optional()
    .describe('Translations: [{ locale, label, placeholder? }]'),
  fileFieldOptions: z
    .record(z.unknown())
    .optional()
    .describe(
      'Required for fieldType file: { allowedExtensions: string[], maxFileSizeMB, maxFiles, enableCameraCapture? }',
    ),
}

const pipelineStageShape = {
  name: z.string().max(100),
  color: z.string().max(20),
  isWon: z.boolean().optional(),
  isLost: z.boolean().optional(),
  winProbability: z.number().min(0).max(100).optional(),
  rottingDays: z.number().optional(),
  requiredCustomFields: z.array(z.string()).optional(),
  salesMilestone: z
    .enum(SALES_MILESTONES)
    .nullable()
    .optional()
    .describe(
      'What entering this stage records for the Sales Learning report (start/demo/offer date). null clears it.',
    ),
}

/**
 * The nested objects list_deals embeds per deal. Each one roughly doubles the
 * response size on a workspace with real contact/company records, so they are
 * stripped by default and restored only on request via `expand`.
 */
const DEAL_EMBEDDED_FIELDS = ['crmCompany', 'contact', 'stage', 'owner', 'contacts'] as const

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001+'] as const

const COMMUNICATION_TYPES = ['whatsapp', 'email', 'call', 'sms'] as const
const COMMUNICATION_DIRECTIONS = ['inbound', 'outbound'] as const
const COMMUNICATION_OUTCOMES = ['connected', 'no_answer', 'voicemail', 'busy'] as const
const contactAddressSchema = z
  .object({
    line1: z.string().max(255).optional(),
    line2: z.string().max(255).optional(),
    line3: z.string().max(255).optional(),
    city: z.string().max(255).optional(),
    zip: z.string().max(32).optional(),
    country: z.string().max(255).optional(),
  })
  .optional()

const CONTACT_ACTIVITY_TYPES = [
  'meeting',
  'email',
  'form',
  'note',
  'task',
  'communication',
  'conversation',
] as const

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
  'zava',
  'jitsi',
  'nextcloudTalk',
  'openTalk',
  'alfaview',
  'hostDefault',
] as const

/**
 * Only fields the API actually keeps.
 *
 * Both meeting-type routes validate with `whitelist: true`, which silently
 * drops any property without a class-validator decorator. Offering a field the
 * API drops would be a lie: the request succeeds, the setting is discarded, and
 * nobody finds out until someone opens the booking page. Add a field only when
 * the current OpenAPI spec documents it on the DTO (`slug` on the create DTO is
 * marked deprecated/ignored and stays out; `confirmationButton`, localised
 * names and the nested policy objects are left to the dashboard).
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
 * Documented on UpdateMeetingInfoDto in the current spec. Kept off the create
 * tool: whether the create route keeps them is not visible in the spec, and
 * the repo's wire test pins them as dropped there.
 */
const meetingInfoUpdateOnlyShape = {
  customChannelName: z.string().optional().describe('Display name for channel "custom"'),
  customChannelLink: z.string().optional().describe('Link for channel "custom"'),
  connectChannelName: z.string().optional().describe('Display name for channel "connect"'),
  groupBooking: z.boolean().optional().describe('Several attendees per slot (see spots)'),
  rollingSlots: z
    .boolean()
    .optional()
    .describe('Restart the slot grid after each appointment'),
}

/**
 * Meeting-type settings that sit beside `meetingInfo` and are shared by the
 * create and update DTOs (same names, same limits).
 */
const meetingTypeCommonShape = {
  spots: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Attendees per slot, for a group booking'),
  locations: z.array(z.string()).optional().describe('Available locations (addresses)'),
  availabilityId: z
    .string()
    .uuid()
    .optional()
    .describe('Existing availability schedule to use'),
  internalNotes: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .describe('Organizer-only note, never shown to customers. null clears it.'),
  contactTags: z
    .array(z.string().max(64))
    .max(10)
    .optional()
    .describe('Tags added to the CRM contact of everyone who books (max 10)'),
  sendHostCalendarInvite: z
    .boolean()
    .optional()
    .describe('Host notification emails carry a calendar invite. Default on.'),
  daysIntoFuture: z
    .object({
      mode: z.enum(['limit', 'range', 'forever']),
      bookingLimit: z.number().min(1).optional().describe('limit mode: minutes from now'),
      rangeMin: z.string().optional().describe('range mode: ISO 8601'),
      rangeMax: z.string().optional().describe('range mode: ISO 8601'),
      countMode: z.enum(['calendar', 'weekday']).optional().describe('limit mode'),
    })
    .optional()
    .describe('How far ahead people can book'),
  ics: z
    .object({
      title: z.union([z.string(), z.record(z.string())]).optional(),
      description: z.union([z.string(), z.record(z.string())]).optional(),
      location: z.union([z.string(), z.record(z.string())]).optional(),
    })
    .optional()
    .describe(
      'Calendar invite templates; a string, or {"en": "...", "de": "..."} per language',
    ),
}

const MEETING_TYPE_TOP_LEVEL = Object.keys(meetingTypeCommonShape)

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

type CrmScopeId = { crmCompanyId?: string; dealId?: string; contactId?: string }

/**
 * Notes and attachments always hang off exactly one parent. The API 400s zero
 * or multiple with its own message, but that reads as a broken tool rather
 * than a usage mistake — this throws the same complaint before the request
 * goes out.
 */
function exactlyOneScopeId(
  ids: CrmScopeId,
): { key: keyof CrmScopeId; value: string } {
  // Reads only the three known keys — callers may pass a larger args object
  // (create_note also carries `content`), and that must never count as a
  // fourth candidate.
  const entries = (['crmCompanyId', 'dealId', 'contactId'] as const)
    .map((key) => [key, ids[key]] as const)
    .filter((entry): entry is [keyof CrmScopeId, string] => entry[1] !== undefined)
  if (entries.length !== 1) {
    throw new Error('Provide exactly one of crmCompanyId, contactId or dealId')
  }
  const [key, value] = entries[0]
  return { key, value }
}

const CRM_SCOPE_PARENTS: Record<keyof CrmScopeId, string> = {
  crmCompanyId: 'companies',
  dealId: 'deals',
  contactId: 'contacts',
}

/** e.g. `/crm/companies/co-1/notes`, `/crm/deals/d-1/attachments`. */
function scopedCrmPath(ids: CrmScopeId, suffix: string): string {
  const { key, value } = exactlyOneScopeId(ids)
  return `/crm/${CRM_SCOPE_PARENTS[key]}/${value}/${suffix}`
}

interface ContactSummary {
  contactId: string
  firstName?: string
  lastName?: string
  email?: string
  phoneNumber?: string
  crmCompanyId?: string
}

/** The handful of fields find_duplicate_contacts groups on, off a raw /crm row. */
function summarizeContact(raw: unknown): ContactSummary {
  const c = raw as Record<string, unknown>
  return {
    contactId: String(c.id ?? ''),
    firstName: typeof c.firstName === 'string' ? c.firstName : undefined,
    lastName: typeof c.lastName === 'string' ? c.lastName : undefined,
    email: typeof c.email === 'string' ? c.email : undefined,
    phoneNumber: typeof c.phoneNumber === 'string' ? c.phoneNumber : undefined,
    crmCompanyId: typeof c.crmCompanyId === 'string' ? c.crmCompanyId : undefined,
  }
}

/**
 * Pull the array of data-field rows out of a /data-field page. Unconfirmed
 * against the live API which of these shapes it actually returns (a bare
 * array vs a wrapped page), so every plausible one is tried before giving up
 * on the page — same defensive spirit as summarizeContact's callers above.
 */
function extractDataFields(response: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(response)) return response as Array<Record<string, unknown>>
  const r = (response ?? {}) as Record<string, unknown>
  for (const key of ['data', 'items', 'result', 'fields']) {
    if (Array.isArray(r[key])) return r[key] as Array<Record<string, unknown>>
  }
  return []
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
      'Return the authenticated account and, when available, its plan tier and relevant caps. This is a low-cost authentication check that distinguishes a bad token from an empty calendar. Plan data explains action-specific limits; it does not gate the connection itself. The account does not change within a session — call this once and reuse the id, name and email rather than calling it again.',
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
      calculationMethod: z
        .enum(['everyone', 'anyone'])
        .optional()
        .describe('Multi-host types: slots where everyone or anyone is free'),
      channel: z
        .enum(MEETING_CHANNELS)
        .optional()
        .describe('Per-channel availability lookup for this location type'),
      attendeeEmail: z
        .string()
        .optional()
        .describe(
          'Booker email, for round-robin types with account-owner matching: narrows to the matched host',
        ),
      hideGroupAppointments: z.boolean().optional(),
      troubleshoot: z
        .boolean()
        .optional()
        .describe('Also return blocked timeslots, to diagnose missing slots'),
      refreshCache: z
        .boolean()
        .optional()
        .describe('Skip the availability cache, e.g. after a slot-occupied error'),
      resourceChannelIds: z.array(z.string()).optional().describe('Resource channel ids'),
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
      email: z
        .string()
        .email()
        .optional()
        .describe('Attendee email. Required unless phoneOnlyBooking is true.'),
      firstName: z.string().max(150).optional(),
      lastName: z.string().max(150).optional(),
      fullName: z
        .string()
        .max(150)
        .optional()
        .describe('Use when the name cannot be split reliably'),
      phone: z.string().optional(),
      language: z.enum(ATTENDEE_LANGUAGES).optional().describe('Attendee language'),
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
      channel: z
        .enum(MEETING_CHANNELS)
        .optional()
        .describe('Location type, when the meeting type offers several'),
      ignoreAvailability: z
        .boolean()
        .optional()
        .describe(
          'Skip availability, conflict and capacity checks (team members only). Confirm with the user first.',
        ),
      skipNotifications: z
        .boolean()
        .optional()
        .describe('Do not email the attendee about this booking'),
      phoneOnlyBooking: z
        .boolean()
        .optional()
        .describe(
          'Book without an email, phone identifies the attendee. Needs allowPhoneOnlyBooking on the meeting type.',
        ),
      icsTitle: z.string().max(200).optional().describe('Overrides the calendar invite title'),
      icsDescription: z
        .string()
        .max(2000)
        .optional()
        .describe('Overrides the calendar invite description'),
      bookingPassword: z
        .string()
        .optional()
        .describe('For a password-protected booking page'),
      couponCode: z.string().max(32).optional().describe('Discount code for paid bookings'),
      priceOptionId: z
        .string()
        .max(64)
        .optional()
        .describe('Chosen price option, for meeting types priced by options'),
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
        language,
        timezone,
        receiveReminders,
        notes,
        guestEmails,
        hostIds,
        queueId,
        channel,
        ignoreAvailability,
        skipNotifications,
        phoneOnlyBooking,
        icsTitle,
        icsDescription,
        bookingPassword,
        couponCode,
        priceOptionId,
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

      if (!email && !phoneOnlyBooking) {
        throw new Error('Provide the attendee email (or set phoneOnlyBooking with a phone).')
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
          channel,
          ignoreAvailability,
          skipNotifications,
          phoneOnlyBooking,
          icsTitle,
          icsDescription,
          bookingPassword,
          couponCode,
          priceOptionId,
          attendee: {
            email,
            firstname: firstName,
            lastname: lastName,
            fullname: fullName,
            phone,
            language,
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
      channel: z.enum(MEETING_CHANNELS).optional().describe('Filter by location type'),
      workspaceId: z.string().optional(),
      all: z.boolean().optional().describe('Every booking in the company (admin only)'),
      userId: z.string().optional().describe("Another user's bookings (admin only)"),
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
    schema: {
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone that defines "today", e.g. Europe/Berlin. Defaults to this machine.'),
    },
    readOnly: true,
    // The API marks `timezone` required; without it "today" has no meaning.
    run: async (client, { timezone }) =>
      presentSchedulingResult(
        'today-appointments',
        await client.request('GET', '/appointment/today', {
          query: {
            timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        }),
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
      'Search the CRM by name, email, phone or tag. Results expose contactIds and support duplicate checks before contact creation. searchTerm is a substring match, so a partial email can return contacts you did not mean to match; pass email instead when you have a full address and want only an exact match.',
    schema: {
      searchTerm: z.string().optional().describe('Matches name, email or phone'),
      email: z
        .string()
        .email()
        .optional()
        .describe(
          'Exact, case-insensitive email match for duplicate checks — takes precedence over searchTerm. Only the first page of the underlying search is checked, so a generic address (e.g. info@) that has more matches than fit on one page can still miss the one you want; narrow with tags or ownerId if that happens.',
        ),
      tags: z.array(z.string()).optional(),
      ownerId: z.string().optional().describe('Filter by account owner'),
      sortBy: z.enum(['firstName', 'lastName', 'email', 'createdAt']).optional(),
      sortOrder: z.enum(['ASC', 'DESC']).optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    readOnly: true,
    run: async (client, args) => {
      const { email, ...rest } = args
      if (!email) {
        return client.request('GET', '/crm', { query: rest, root: true })
      }
      const result = (await client.request('GET', '/crm', {
        query: { ...rest, searchTerm: email },
        root: true,
      })) as Record<string, unknown>
      const target = email.toLowerCase()
      const isExactMatch = (contact: unknown) =>
        typeof (contact as { email?: unknown }).email === 'string' &&
        (contact as { email: string }).email.toLowerCase() === target
      // PaginatedContacts names the array `result` — checked against the
      // authoritative OpenAPI spec, not the earlier `items`/`data` guesses,
      // which never matched and left this filter silently a no-op.
      if (Array.isArray(result.result)) {
        return { ...result, result: result.result.filter(isExactMatch) }
      }
      if (Array.isArray(result.items)) {
        return { ...result, items: result.items.filter(isExactMatch) }
      }
      if (Array.isArray(result.data)) {
        return { ...result, data: result.data.filter(isExactMatch) }
      }
      if (Array.isArray(result)) return result.filter(isExactMatch)
      return result
    },
  },
  {
    name: 'find_duplicate_contacts',
    title: 'Find duplicate contacts',
    description:
      "Group existing contacts that share a normalized email, phone number or full name — the same grouping the web UI's duplicate panel shows, computed here instead of on a dedicated endpoint, because there isn't one; the CRM API has real dedup/merge endpoints for deals, but none for contacts. Pages through every contact with no cap, so a very large contact base means many sequential calls. Phone matching strips everything but digits, so the same number in two different formats still matches, but two different country-code writings of the same underlying number may not.",
    schema: {},
    readOnly: true,
    run: async (client) => {
      const contacts: ContactSummary[] = []
      const limit = 1000
      for (let page = 1; ; page += 1) {
        const response = (await client.request('GET', '/crm', {
          query: { page, limit },
          root: true,
        })) as { result?: unknown[]; totalPages?: number }
        const batch = Array.isArray(response.result) ? response.result : []
        contacts.push(...batch.map(summarizeContact))
        if (!response.totalPages || page >= response.totalPages || batch.length === 0) break
      }

      const groups = new Map<string, { reason: 'email' | 'phone' | 'name'; key: string; contacts: ContactSummary[] }>()
      const addTo = (reason: 'email' | 'phone' | 'name', key: string, contact: ContactSummary) => {
        const groupKey = `${reason}:${key}`
        const group = groups.get(groupKey) ?? { reason, key, contacts: [] }
        group.contacts.push(contact)
        groups.set(groupKey, group)
      }

      for (const contact of contacts) {
        if (contact.email) addTo('email', contact.email.trim().toLowerCase(), contact)
        const digits = contact.phoneNumber?.replace(/\D/g, '')
        if (digits) addTo('phone', digits, contact)
        const name = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim().toLowerCase()
        if (name) addTo('name', name, contact)
      }

      return {
        totalContactsScanned: contacts.length,
        duplicateGroups: [...groups.values()].filter((g) => g.contacts.length > 1),
      }
    },
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
      'Create a CRM contact. Either email or phoneNumber is required. Existing contacts are not deduplicated. Pass crmCompanyId to link the contact to an existing CRM company.',
    schema: {
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      phoneNumber: z.string().optional(),
      tags: z.array(z.string()).optional().describe('e.g. ["Lead", "Enterprise"]'),
      notes: z.string().optional().describe('Internal notes, not visible to the contact'),
      accountOwnerId: z.string().optional(),
      crmCompanyId: z.string().optional(),
      birthday: z.string().nullable().optional().describe('YYYY-MM-DD'),
      address: contactAddressSchema,
      additionalData: z
        .record(z.unknown())
        .optional()
        .describe(
          'Custom field values keyed by the exact-case name from list_data_fields. Not validated against the field definitions — a misspelled key is silently stored, not rejected.',
        ),
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
      "Update a CRM contact. Only supplied fields change. Tags replace the existing list rather than merging, so retained tags must be included. Pass crmCompanyId to link to a company, or null to remove the link. title/employer/seniority/function/location are the fields an automated research feature suggests and a person corrects — editing one here marks it human-owned, so the research feature stops overwriting it.",
    schema: {
      contactId: z.string(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      phoneNumber: z.string().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
      accountOwnerId: z.string().optional(),
      crmCompanyId: z.string().nullable().optional(),
      language: z.string().max(8).optional().describe('ISO 639-1, e.g. "de"'),
      birthday: z.string().nullable().optional().describe('YYYY-MM-DD; null clears it'),
      address: contactAddressSchema,
      title: z.string().optional(),
      employer: z.string().optional(),
      seniority: z.string().optional(),
      function: z.string().optional(),
      location: z.string().optional(),
      additionalData: z
        .record(z.unknown().nullable())
        .optional()
        .describe(
          'Custom field values keyed by the exact-case name from list_data_fields, merged into what exists — a key set to null removes it. Not validated against the field definitions — a misspelled key is silently stored, not rejected.',
        ),
    },
    readOnly: false,
    // Tags replace rather than merge — a careless call silently drops data.
    destructive: true,
    run: (client, { contactId, ...body }) =>
      client.request('PATCH', `/crm/${contactId}`, { body, root: true }),
  },
  {
    name: 'set_contact_source_type',
    title: "Tag a contact's source type",
    description:
      "Tag a contact with an account-defined source-type flag (e.g. network_contact vs standard_customer vs cold_outreach) — the distinction later automation needs before it may ever propose a multi-step sequence instead of a single individual touch for a given contact. Provisions its own backing field on first use: pages through the reusable form fields looking for one whose internal key already matches, and only creates a new select field when none is found, so this does not depend on someone setting the field up by hand in the account first. Whether that field listing comes back as a bare array or a wrapped page is unconfirmed against the live API, so both are handled.",
    schema: {
      contactId: z.string(),
      value: z.string().describe('e.g. network_contact, standard_customer or cold_outreach — the taxonomy is account-specific, not fixed by the API'),
      contactSourceField: z
        .string()
        .optional()
        .describe(
          "Custom field key to write, and its internal key if it has to be created. Defaults to 'contactSourceType' — the same default the quiet-deals finder reads.",
        ),
      fieldLabel: z.string().optional().describe("Label shown on the field if it must be created. Defaults to 'Kontaktart'."),
      fieldOptions: z
        .array(z.string())
        .optional()
        .describe(
          "Select options if the field must be created. Defaults to ['network_contact', 'standard_customer', 'cold_outreach'].",
        ),
    },
    readOnly: false,
    run: async (client, args) => {
      const field = args.contactSourceField ?? 'contactSourceType'
      const label = args.fieldLabel ?? 'Kontaktart'
      const options: string[] = args.fieldOptions ?? ['network_contact', 'standard_customer', 'cold_outreach']

      let fieldExists = false
      for (let offset = 0; ; offset += 50) {
        const response = await client.request('GET', '/data-field', { query: { limit: 50, offset } })
        const batch = extractDataFields(response)
        if (batch.some((f) => f.name === field)) {
          fieldExists = true
          break
        }
        if (batch.length < 50) break
      }

      let fieldCreated = false
      if (!fieldExists) {
        await client.request('POST', '/data-field', {
          body: {
            label,
            fieldType: 'select',
            name: field,
            options: options.map((value) => ({ label: value, value })),
          },
        })
        fieldCreated = true
      }

      await client.request('PATCH', `/crm/${args.contactId}`, {
        body: { additionalData: { [field]: args.value } },
        root: true,
      })

      return {
        contactId: args.contactId,
        contactSourceField: field,
        value: args.value,
        fieldCreated,
      }
    },
  },
  {
    name: 'list_calendar_connections',
    title: 'List calendar connections',
    description:
      'List connected calendars (Google, Outlook and CalDAV). The result shows whether a host has a calendar attached and supports availability diagnosis.',
    schema: {
      userId: z.string().optional().describe("Another user's connections (admin only)"),
    },
    readOnly: true,
    run: (client, query) =>
      client.request('GET', '/calendar-connections/connections', {
        query: definedOnly(query),
      }),
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
        .max(500000)
        .nullable()
        .optional()
        .describe('Full transcript in markdown, or null to clear'),
      summary: z
        .string()
        .max(100000)
        .nullable()
        .optional()
        .describe('Summary in markdown, or null to clear'),
      actualStartAt: z.string().optional().describe('ISO 8601, when the recorded conversation began'),
      actualEndAt: z.string().optional().describe('ISO 8601, when the recorded conversation ended'),
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
      ...meetingTypeCommonShape,
      isGlobalQueue: z
        .boolean()
        .optional()
        .describe('Create as a company-wide round robin'),
      workspaceId: z.string().uuid().optional().describe('Workspace, for workspace meeting types'),
    },
    readOnly: false,
    openWorld: true,
    run: (client, args) => {
      const { isGlobalQueue, workspaceId, ...rest } = args
      const top = Object.fromEntries(
        Object.entries(rest).filter(([k]) => MEETING_TYPE_TOP_LEVEL.includes(k)),
      )
      const info = Object.fromEntries(
        Object.entries(rest).filter(([k]) => !MEETING_TYPE_TOP_LEVEL.includes(k)),
      )
      return client.request('POST', '/meeting-type', {
        body: {
          meetingInfo: definedOnly(info),
          ...top,
          isGlobalQueue,
          workspaceId,
        },
      })
    },
  },
  {
    name: 'update_meeting_type',
    title: 'Update a meeting type',
    description:
      'Change a meeting type. Only the fields you send change; everything you leave out keeps its current value.',
    schema: {
      meetingTypeId: z.string(),
      ...meetingInfoShape,
      ...meetingTypeCommonShape,
      ...meetingInfoUpdateOnlyShape,
      // Everything is optional on a patch — the create-time requirements do
      // not apply, and UpdateMeetingInfoDto is fully partial.
      name: meetingInfoShape.name.optional(),
      description: meetingInfoShape.description.optional(),
      duration: meetingInfoShape.duration.optional(),
      channel: meetingInfoShape.channel.optional(),
      // Unlike the create DTO, slug is validated here, so it survives.
      slug: z.string().optional().describe('URL segment of the booking page'),
      enabled: z.boolean().optional().describe('Enable or disable the meeting type'),
      timeslotInterval: z
        .number()
        .int()
        .min(5)
        .max(60)
        .optional()
        .describe('Minutes between offered slots, 5 to 60'),
      bookingMinimum: z
        .number()
        .int()
        .min(0)
        .max(10080)
        .optional()
        .describe('Minimum booking notice in minutes, max 10080'),
    },
    readOnly: false,
    openWorld: true,
    destructive: true,
    run: (client, args) => {
      const { meetingTypeId, slug, enabled, timeslotInterval, bookingMinimum, ...rest } = args
      const top = Object.fromEntries(
        Object.entries(rest).filter(([k]) => MEETING_TYPE_TOP_LEVEL.includes(k)),
      )
      const meetingInfo = definedOnly(
        Object.fromEntries(
          Object.entries(rest).filter(([k]) => !MEETING_TYPE_TOP_LEVEL.includes(k)),
        ),
      )
      return client.request('PATCH', `/meeting-type/${meetingTypeId}`, {
        // Omit meetingInfo entirely when only top-level settings changed,
        // rather than sending an empty object.
        body: {
          ...(Object.keys(meetingInfo).length ? { meetingInfo } : {}),
          ...top,
          slug,
          enabled,
          timeslotInterval,
          bookingMinimum,
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
      showMeetingsSection: z
        .boolean()
        .optional()
        .describe('Show the automatic meetings section above the content blocks'),
      showContactExchange: z
        .boolean()
        .optional()
        .describe('Offer visitors the contact-exchange form next to "save contact"'),
      theme: z
        .object({
          preset: z.string().optional().describe('e.g. classic, nocturne'),
          accent: z.string().optional().describe('Hex'),
          background: z
            .object({ type: z.enum(['solid', 'gradient', 'image']), value: z.string() })
            .partial()
            .optional(),
          font: z.enum(['sans', 'serif', 'grotesk', 'mono', 'condensed', 'rounded']).optional(),
          buttonShape: z.enum(['sharp', 'rounded', 'pill']).optional(),
        })
        .nullable()
        .optional()
        .describe('Card theme; null restores the default look (useCustomColors then applies)'),
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
      "List the reusable form fields shared across routing forms, including fields that may already match a planned addition. Each field's `name` is the exact key any `customFields` write elsewhere expects — match the field by its `label` here, then write using its `name`. Returns 50 at a time with offset pagination.",
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
        .enum(DATA_FIELD_TARGETS)
        .optional()
        .describe('Maps the answer onto a known attendee field. Defaults to other (custom).'),
      ...dataFieldExtraShape,
    },
    readOnly: false,
    // The API lists target, default, required and hidden as required on create;
    // fill the neutral values so the model need not know.
    run: (client, body) =>
      client.request('POST', '/data-field', {
        body: { target: 'other', default: false, required: false, hidden: false, ...definedOnly(body) },
      }),
  },
  {
    name: 'update_data_field',
    title: 'Update a data field',
    description:
      "Change a reusable form field: label, type, internal key, required flag, choice options or target mapping. Only supplied fields change. Check where the field is actually used first — a live type change on a field already answered on real forms can strand those old answers.",
    schema: {
      fieldId: z.number().describe('Numeric id, from list_data_fields'),
      label: z.string().optional(),
      fieldType: z.enum(DATA_FIELD_TYPES).optional(),
      name: z.string().optional(),
      required: z.boolean().optional(),
      options: z.array(z.record(z.unknown())).optional().describe('For choice fields: [{ label, value }]'),
      target: z.enum(DATA_FIELD_TARGETS).optional(),
      ...dataFieldExtraShape,
    },
    readOnly: false,
    run: (client, { fieldId, ...body }) => client.request('PATCH', `/data-field/${fieldId}`, { body }),
  },
  {
    name: 'delete_data_field',
    title: 'Delete a data field',
    description:
      'Permanently delete a reusable form field. Check where it is actually used first — a field still referenced by live forms may leave those forms with a dangling reference.',
    schema: { fieldId: z.number().describe('Numeric id, from list_data_fields') },
    readOnly: false,
    destructive: true,
    run: (client, { fieldId }) => client.request('DELETE', `/data-field/${fieldId}`, {}),
  },
  {
    name: 'get_data_field_usage',
    title: 'Get a data field usage',
    description: 'Show where a reusable form field is actually used, before editing or deleting it.',
    schema: { fieldId: z.number().describe('Numeric id, from list_data_fields') },
    readOnly: true,
    // Unlike the rest of /data-field (mounted under /v4), this one route
    // lives at the host root — confirmed live: /v4/data-field/{id}/usage
    // 404s, root: true (plain /data-field/{id}/usage) works.
    run: (client, { fieldId }) =>
      client.request('GET', `/data-field/${fieldId}/usage`, { root: true }),
  },
  {
    name: 'reorder_data_fields',
    title: 'Reorder data fields',
    description: 'Set the display order of reusable form fields. Pass every fieldId, in the new order — this replaces the order wholesale, not a partial move.',
    schema: { fieldIds: z.array(z.number()).min(1) },
    readOnly: false,
    run: (client, { fieldIds }) => client.request('PATCH', '/data-field/reorder', { body: { fieldIds } }),
  },

  // ---- CRM ----------------------------------------------------------------
  {
    name: 'bulk_create_contacts',
    title: 'Bulk-create contacts',
    description:
      'Create many contacts in one import. Each needs email or phoneNumber. A call accepts up to 1000 contacts and the endpoint is limited to 3 calls per minute. A contact with crmCompanyRef also auto-creates a separate, unlisted ContactCompany record from its email domain if that domain hasn\'t been seen before — harmless for a handful of known test domains, but a large import across many distinct domains leaves that many orphan records with no endpoint to view or remove them.',
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
              accountOwnerEmail: z
                .string()
                .email()
                .optional()
                .describe('A user in the same account, set as the contact’s owner'),
              meetingTypeRef: z.string().optional().describe('Meeting type UUID or name'),
              crmCompanyRef: z
                .string()
                .optional()
                .describe(
                  'CrmCompany UUID or display name; an unknown name is auto-created so new companies never fail the row',
                ),
              additionalData: z
                .record(z.unknown())
                .optional()
                .describe('Arbitrary extra data (UTM params, source, ...) stored on the contact'),
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
      updateExisting: z
        .boolean()
        .optional()
        .describe('Update existing contacts by email instead of skipping them'),
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
  {
    name: 'bulk_delete_contacts',
    title: 'Bulk-delete contacts',
    description:
      'Permanently delete up to 500 contacts in one call — the natural cleanup after a bulk import that turns out wrong or premature, or after a round of test contacts. Only contacts belonging to this account are removed. Throttled to 3 calls per minute given the destructive effect; there is no undo.',
    schema: {
      contactIds: z.array(z.string()).min(1).max(500),
    },
    readOnly: false,
    destructive: true,
    run: (client, body) =>
      client.request('POST', '/crm/bulk-delete', { body, root: true }),
  },
  {
    name: 'get_contact_timeline',
    title: "Get a contact's activity timeline",
    description:
      "Return a contact's unified activity feed — meetings, synced emails, form submissions, notes, tasks, communications and conversations — merged and ordered by occurredAt, cursor-paginated. Far more compact than reading notes, tasks and emails separately when the question is simply what happened with this lead so far.",
    schema: {
      contactId: z.string(),
      types: z.array(z.enum(CONTACT_ACTIVITY_TYPES)).optional().describe('Restrict to these entry types'),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().describe('Defaults to 30'),
    },
    readOnly: true,
    run: (client, { contactId, ...query }) =>
      client.request('GET', `/crm/contacts/${contactId}/activity`, { query, root: true }),
  },
  {
    name: 'get_contact_emails',
    title: "Get a contact's synced emails",
    description:
      'List synced email headers and previews for a contact — subject, snippet, from/to, direction, sentAt. Fetch a full body separately; this is the index only.',
    schema: {
      contactId: z.string(),
      limit: z.number().int().min(1).optional(),
      offset: z.number().int().min(0).optional(),
    },
    readOnly: true,
    run: (client, { contactId, ...query }) =>
      client.request('GET', `/crm/contacts/${contactId}/emails`, { query, root: true }),
  },
  {
    name: 'get_deal_emails',
    title: "Get a deal's synced emails",
    description:
      'List synced email headers and previews for a deal — subject, snippet, from/to, direction, sentAt. Fetch a full body separately; this is the index only.',
    schema: {
      dealId: z.string(),
      limit: z.number().int().min(1).optional(),
      offset: z.number().int().min(0).optional(),
    },
    readOnly: true,
    run: (client, { dealId, ...query }) =>
      client.request('GET', `/crm/deals/${dealId}/emails`, { query, root: true }),
  },
  {
    name: 'get_email_body',
    title: 'Get a synced email body',
    description:
      "Fetch a synced email's full body on demand from the provider (Gmail/Outlook) — HTML, plain text, and its attachment list. The body is never stored ahead of time; the synced-email listing tools only keep the header and preview snippet.",
    schema: { emailId: z.string() },
    readOnly: true,
    run: (client, { emailId }) => client.request('GET', `/crm/emails/${emailId}/body`, { root: true }),
  },
  {
    name: 'get_email_send_capability',
    title: 'Check email send capability',
    description:
      "Return whether the current user's connected mailbox (Google, Microsoft or IMAP) could send an email right now. There is no send endpoint yet — draft the email as text in the reply and let the human send it.",
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/crm/emails/send-capability', { root: true }),
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
    name: 'create_pipeline',
    title: 'Create a pipeline',
    description:
      "Create a sales pipeline, optionally with its stages in one call. name is optional — the API fills in the standard name in the caller's language when omitted.",
    schema: {
      name: z.string().max(100).optional(),
      isDefault: z.boolean().optional(),
      stages: z.array(z.object(pipelineStageShape)).optional(),
    },
    readOnly: false,
    run: (client, body) => client.request('POST', '/crm/pipelines', { body, root: true }),
  },
  {
    name: 'update_pipeline',
    title: 'Update a pipeline',
    description: 'Rename a pipeline or change which one is the default. Only supplied fields change.',
    schema: {
      pipelineId: z.string(),
      name: z.string().max(100).optional(),
      isDefault: z.boolean().optional(),
    },
    readOnly: false,
    run: (client, { pipelineId, ...body }) =>
      client.request('PATCH', `/crm/pipelines/${pipelineId}`, { body, root: true }),
  },
  {
    name: 'delete_pipeline',
    title: 'Delete a pipeline',
    description: 'Permanently delete a pipeline and its stages. Deals in it are not moved first — check for any before deleting.',
    schema: { pipelineId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { pipelineId }) =>
      client.request('DELETE', `/crm/pipelines/${pipelineId}`, { root: true }),
  },
  {
    name: 'add_pipeline_stage',
    title: 'Add a pipeline stage',
    description:
      'Add a stage to an existing pipeline. name and color are required; salesMilestone (start/demo/offer) marks the stage for the Sales Learning report — set it on the stages that represent those milestones (e.g. an "Angebot" stage as offer) or those reports stay empty.',
    schema: {
      pipelineId: z.string(),
      ...pipelineStageShape,
    },
    readOnly: false,
    run: (client, { pipelineId, ...body }) =>
      client.request('POST', `/crm/pipelines/${pipelineId}/stages`, { body, root: true }),
  },
  {
    name: 'update_pipeline_stage',
    title: 'Update a pipeline stage',
    description:
      "Change a stage: name, color, won/lost flags, win probability, rotting threshold, required custom fields, or its salesMilestone (start/demo/offer, or null to clear it). Only supplied fields change. The response itself isn't reliably complete — a field left untouched has come back null here even though it was unchanged; re-read the pipeline list for the actual current state rather than trusting this call's own response.",
    schema: {
      pipelineId: z.string(),
      stageId: z.string(),
      ...pipelineStageShape,
      name: pipelineStageShape.name.optional(),
      color: pipelineStageShape.color.optional(),
    },
    readOnly: false,
    run: (client, { pipelineId, stageId, ...body }) =>
      client.request('PATCH', `/crm/pipelines/${pipelineId}/stages/${stageId}`, { body, root: true }),
  },
  {
    name: 'delete_pipeline_stage',
    title: 'Delete a pipeline stage',
    description:
      'Permanently delete a stage. moveToStageId is required: every deal currently in this stage moves there first, so no deal is left in limbo.',
    schema: {
      pipelineId: z.string(),
      stageId: z.string(),
      moveToStageId: z.string(),
    },
    readOnly: false,
    destructive: true,
    run: (client, { pipelineId, stageId, moveToStageId }) =>
      client.request('DELETE', `/crm/pipelines/${pipelineId}/stages/${stageId}`, {
        query: { moveToStageId },
        root: true,
      }),
  },
  {
    name: 'reorder_pipeline_stages',
    title: 'Reorder pipeline stages',
    description: "Set the display order of a pipeline's stages. Pass every stageId in the pipeline, in the new order — this replaces the order wholesale, not a partial move.",
    schema: {
      pipelineId: z.string(),
      stageIds: z.array(z.string()).min(1),
    },
    readOnly: false,
    run: (client, { pipelineId, stageIds }) =>
      client.request('PATCH', `/crm/pipelines/${pipelineId}/stages/reorder`, {
        body: { stageIds },
        root: true,
      }),
  },
  {
    name: 'list_deals',
    title: 'List deals',
    description:
      'Search and filter deals by pipeline, stage, contact, company, owner or a name match. isOpen, isWon and isLost filter by outcome; paginated with page and limit. Each deal comes back without its embedded company, contact, stage, owner and contact-list objects — pass expand to add specific ones back when you need more than the ids.',
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
      expand: z
        .array(z.enum(DEAL_EMBEDDED_FIELDS))
        .optional()
        .describe(
          'Which embedded objects to keep on each deal (crmCompany, contact, stage, owner, contacts). Omitted ones are stripped to keep the response small.',
        ),
    },
    readOnly: true,
    run: async (client, args) => {
      const { expand, ...query } = args
      const result = (await client.request('GET', '/crm/deals', {
        query,
        root: true,
      })) as Record<string, unknown>
      const keep = new Set(expand ?? [])
      const strip = DEAL_EMBEDDED_FIELDS.filter((field) => !keep.has(field))
      if (!Array.isArray(result.deals) || strip.length === 0) return result
      return {
        ...result,
        deals: result.deals.map((deal: Record<string, unknown>) => {
          const trimmed = { ...deal }
          for (const field of strip) delete trimmed[field]
          return trimmed
        }),
      }
    },
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
      winProbability: z
        .number()
        .min(0)
        .max(100)
        .nullable()
        .optional()
        .describe('Win probability in percent for this deal only; null returns it to the value of its stage. Sent together with stageId it applies to the new stage.'),
      customFields: z.record(z.unknown()).optional(),
    },
    readOnly: false,
    run: (client, { dealId, ...body }) =>
      client.request('PATCH', `/crm/deals/${dealId}`, { body, root: true }),
  },
  {
    name: 'add_deal_contact',
    title: 'Add a contact to a deal',
    description:
      "Link another contact to a deal with a role — decision_maker, influencer, user, primary or other — beyond the deal's single contactId. Reading a deal already embeds the resulting contacts array with each role.",
    schema: {
      dealId: z.string(),
      contactId: z.string(),
      role: z.enum(DEAL_CONTACT_ROLES).optional(),
      isPrimary: z.boolean().optional(),
    },
    readOnly: false,
    run: (client, { dealId, ...body }) =>
      client.request('POST', `/crm/deals/${dealId}/contacts`, { body, root: true }),
  },
  {
    name: 'update_deal_contact',
    title: "Change a deal contact's role",
    description:
      "Change the role or primary flag of a contact already linked to a deal. dealContactId is the link's own id, from the deal's embedded contacts array — not the contactId itself.",
    schema: {
      dealId: z.string(),
      dealContactId: z.string(),
      role: z.enum(DEAL_CONTACT_ROLES).optional(),
      isPrimary: z.boolean().optional(),
    },
    readOnly: false,
    run: (client, { dealId, dealContactId, ...body }) =>
      client.request('PATCH', `/crm/deals/${dealId}/contacts/${dealContactId}`, { body, root: true }),
  },
  {
    name: 'remove_deal_contact',
    title: 'Remove a contact from a deal',
    description:
      "Unlink a contact from a deal. dealContactId is the link's own id, from the deal's embedded contacts array — not the contactId itself. The contact record and the deal itself are untouched.",
    schema: {
      dealId: z.string(),
      dealContactId: z.string(),
    },
    readOnly: false,
    destructive: true,
    run: (client, { dealId, dealContactId }) =>
      client.request('DELETE', `/crm/deals/${dealId}/contacts/${dealContactId}`, { root: true }),
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
  {
    name: 'get_deal_appointments',
    title: "Get a deal's appointments",
    description: 'List appointments booked or held directly on a deal.',
    schema: { dealId: z.string() },
    readOnly: true,
    run: (client, { dealId }) =>
      client.request('GET', `/crm/deals/${dealId}/appointments`, { root: true }),
  },
  {
    name: 'get_deal_summary',
    title: 'Get deal summary',
    description:
      'Aggregate deal counts and value across the pipeline: open/won/lost, weighted forecast, and a breakdown by stage. The API spec marks ownerId and pipelineId required; live-confirmed that omitting both is not an error — it returns the full pipeline, every owner and every stage. Pass either to scope the summary down.',
    schema: {
      ownerId: z.string().optional(),
      pipelineId: z.string().optional(),
    },
    readOnly: true,
    run: (client, args) => client.request('GET', '/crm/deals/summary', { query: args, root: true }),
  },
  {
    name: 'get_deal_limits',
    title: 'Get deal limits',
    description: "Return the account's deal count against its plan limit. limit is -1 when the plan is unlimited.",
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/crm/deals/limits', { root: true }),
  },
  {
    name: 'get_quiet_contacts',
    title: 'Find quiet deals worth a follow-up',
    description:
      "Filter and rank open deals that have gone quiet, reusing the health signal already attached to every deal (signal.daysSinceLastActivity, isRotting) instead of reconstructing rhythm from each deal's own activity log — the same computed-client-side, no-dedicated-endpoint approach this server already uses for duplicate detection. A deal counts as quiet when its stage-level isRotting flag is set, or signal.daysSinceLastActivity reaches minDaysSinceActivity (default 14). Ranked by deal value descending, not by silence duration — a long-quiet low-value deal isn't automatically more urgent than a recently-quiet high-value one — but healthBand and followUpsSinceLastReply still come back on every hit so the caller can re-rank ties itself. Pages through every open deal with no hard cap. This connector has no built-in contact-source-type field — meetergo's CRM doesn't ship one — so contactSourceType is read from the contact's additionalData under contactSourceField (default 'contactSourceType') and comes back null on every hit until that custom data field is created on the account.",
    schema: {
      minDaysSinceActivity: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Quiet threshold in days since last activity. Defaults to 14. A deal already flagged isRotting counts regardless of this value.',
        ),
      pipelineId: z.string().optional(),
      ownerId: z.string().optional(),
      contactSourceField: z
        .string()
        .optional()
        .describe(
          "additionalData key on the contact to read as the source-type flag, e.g. network_contact vs standard_customer. Defaults to 'contactSourceType' — whatever key was chosen when the field was created with create_data_field, not a fixed API field.",
        ),
      contactSourceType: z
        .string()
        .optional()
        .describe('Only return hits whose contact additionalData[contactSourceField] equals this value exactly.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('How many ranked hits to return. Defaults to 20 — the scan itself still covers every open deal.'),
    },
    readOnly: true,
    run: async (client, args) => {
      const pageSize = 200
      const sourceField = args.contactSourceField ?? 'contactSourceType'
      const deals: Record<string, unknown>[] = []
      for (let page = 1; ; page += 1) {
        const response = (await client.request('GET', '/crm/deals', {
          query: {
            page,
            limit: pageSize,
            isOpen: true,
            pipelineId: args.pipelineId,
            ownerId: args.ownerId,
          },
          root: true,
        })) as { deals?: unknown[] }
        const batch = Array.isArray(response.deals) ? (response.deals as Record<string, unknown>[]) : []
        deals.push(...batch)
        if (batch.length < pageSize) break
      }

      const minDays = args.minDaysSinceActivity ?? 14
      const hits = deals
        .map((deal) => {
          const signal = (deal.signal ?? {}) as Record<string, unknown>
          const contact = (deal.contact ?? {}) as Record<string, unknown>
          const additionalData = (contact.additionalData ?? {}) as Record<string, unknown>
          const daysSinceLastActivity =
            typeof signal.daysSinceLastActivity === 'number' ? signal.daysSinceLastActivity : undefined
          const isRotting = deal.isRotting === true
          const rawSourceType = additionalData[sourceField]
          return {
            dealId: String(deal.id ?? ''),
            dealName: typeof deal.name === 'string' ? deal.name : undefined,
            value: typeof deal.value === 'number' ? deal.value : undefined,
            currency: typeof deal.currency === 'string' ? deal.currency : undefined,
            pipelineId: typeof deal.pipelineId === 'string' ? deal.pipelineId : undefined,
            stageId: typeof deal.stageId === 'string' ? deal.stageId : undefined,
            enteredStageAt: typeof deal.enteredStageAt === 'string' ? deal.enteredStageAt : undefined,
            isRotting,
            daysSinceLastActivity,
            healthBand: typeof signal.healthBand === 'string' ? signal.healthBand : undefined,
            followUpsSinceLastReply:
              typeof signal.followUpsSinceLastReply === 'number' ? signal.followUpsSinceLastReply : undefined,
            contactId: typeof contact.id === 'string' ? contact.id : undefined,
            contactFirstName: typeof contact.firstName === 'string' ? contact.firstName : undefined,
            contactLastName: typeof contact.lastName === 'string' ? contact.lastName : undefined,
            contactEmail: typeof contact.email === 'string' ? contact.email : undefined,
            crmCompanyId: typeof deal.crmCompanyId === 'string' ? deal.crmCompanyId : undefined,
            contactSourceType:
              typeof rawSourceType === 'string' || typeof rawSourceType === 'number' ? rawSourceType : null,
            _quiet: isRotting || (daysSinceLastActivity !== undefined && daysSinceLastActivity >= minDays),
          }
        })
        .filter((hit) => hit._quiet)
        .filter((hit) => args.contactSourceType === undefined || hit.contactSourceType === args.contactSourceType)
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
        .slice(0, args.limit ?? 20)
        .map(({ _quiet, ...hit }) => hit)

      return {
        totalOpenDealsScanned: deals.length,
        quietDeals: hits,
      }
    },
  },
  {
    name: 'find_duplicate_deals',
    title: 'Find duplicate deals',
    description:
      'Return deals that look like duplicates of this one (same company, similar name), each with a match score and reasons. Read-only and merges nothing — the caller still picks which candidate, if any, to merge.',
    schema: { dealId: z.string() },
    readOnly: true,
    run: (client, { dealId }) =>
      client.request('GET', `/crm/deals/${dealId}/duplicate-candidates`, { root: true }),
  },
  {
    name: 'get_deal_contact_suggestions',
    title: 'Get contact suggestions for a deal',
    description:
      "Return contacts this deal is probably about, when none is linked yet — matched by phone number or by name. Read-only and links nothing; a wrong link moves someone else's emails and meetings onto the deal, so the caller confirms before linking.",
    schema: { dealId: z.string() },
    readOnly: true,
    run: (client, { dealId }) =>
      client.request('GET', `/crm/deals/${dealId}/contact-suggestions`, { root: true }),
  },
  {
    name: 'merge_deals',
    title: 'Merge duplicate deals',
    description:
      'Merge one or more duplicate deals into a survivor. dealId is the deal that survives; duplicateDealIds are merged into it and then permanently deleted — their notes, tasks, attachments and activity move to the survivor first, but the duplicate records themselves do not come back. Look up candidates and get explicit confirmation before calling this.',
    schema: {
      dealId: z.string().describe('The surviving deal'),
      duplicateDealIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Deals to merge in and delete'),
    },
    readOnly: false,
    destructive: true,
    run: (client, { dealId, duplicateDealIds }) =>
      client.request('POST', `/crm/deals/${dealId}/merge`, {
        body: { duplicateDealIds },
        root: true,
      }),
  },
  {
    name: 'bulk_import_deals',
    title: 'Bulk-import deals',
    description:
      'Upsert contacts and create one deal per row, into one target pipeline stage. Up to 500 rows per call. A row with crmCompanyRef also auto-creates a separate, unlisted ContactCompany record from the contact\'s email domain if the domain hasn\'t been seen before — harmless for a handful of known test domains, but a large import across many distinct domains leaves that many orphan records with no endpoint to view or remove them. Each row needs an email or a phoneNumber, mirroring the plain contact import.',
    schema: {
      rows: z
        .array(
          z
            .object({
              firstName: z.string().optional(),
              lastName: z.string().optional(),
              email: z.string().email().optional(),
              phoneNumber: z.string().optional(),
              tags: z.array(z.string()).optional(),
              notes: z.string().optional().describe("The contact's own note, distinct from dealNotes"),
              accountOwnerEmail: z
                .string()
                .email()
                .optional()
                .describe('A user in the same account, set as the contact’s owner'),
              meetingTypeRef: z.string().optional().describe('Meeting type UUID or name'),
              crmCompanyRef: z
                .string()
                .optional()
                .describe(
                  'CrmCompany UUID or display name; an unknown name is auto-created so new companies never fail the row',
                ),
              additionalData: z
                .record(z.unknown())
                .optional()
                .describe('Arbitrary extra data (UTM params, source, ...) stored on the contact'),
              dealName: z.string().max(255).optional().describe("Falls back to the contact's name"),
              dealValue: z.number().min(0).optional(),
              dealCurrency: z.string().length(3).optional().describe('ISO-4217, defaults to EUR'),
              dealExpectedCloseDate: z.string().optional().describe('YYYY-MM-DD'),
              dealOwnerEmail: z
                .string()
                .email()
                .optional()
                .describe('A user in the same account; unresolvable emails fall back to the importing user'),
              dealNotes: z.string().optional().describe("The deal's own note, distinct from the contact's notes"),
            })
            .refine(
              (r) => Boolean(r.email || r.phoneNumber),
              'Each row needs an email or a phoneNumber',
            ),
        )
        .min(1)
        .max(500),
      pipelineId: z.string(),
      stageId: z.string(),
      updateExisting: z
        .boolean()
        .optional()
        .describe('Update existing contacts by email instead of skipping them. A deal is still created either way.'),
    },
    readOnly: false,
    run: (client, body) => client.request('POST', '/crm/deals/bulk-import', { body, root: true }),
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
        .describe('Keyed by the exact-case key from get_custom_field_definitions'),
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
        .describe('Keyed by the exact-case key from get_custom_field_definitions; null removes a key'),
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
  {
    name: 'get_custom_field_definitions',
    title: 'Get custom field definitions',
    description:
      "Return the configured custom fields on CRM companies or deals: key, label, type, required and — for a multiselect field — its fixed option list. Look this up before writing customFields when creating or updating a company or deal: a misspelled or wrong-cased key is not rejected, it is silently stored as an extra key nobody sees. This is a separate system from the booking-form fields tool, which covers contacts, not companies or deals.",
    schema: {
      recordType: z.enum(['company', 'deal']).optional().describe('Defaults to deal'),
    },
    readOnly: true,
    run: (client, args) =>
      client.request('GET', '/crm/settings/custom-fields', { query: args, root: true }),
  },
  {
    name: 'update_custom_field_definitions',
    title: 'Update custom field definitions',
    description:
      "Replace the entire set of custom field definitions for CRM companies or deals — this is a full replace of the fields array, not a patch: fields left out of the call are gone, not left alone. Read the current set first and send it back with your change folded in. Existing values already stored under a removed field's key are not itself deleted by this, they just lose their definition (type, label, options).",
    schema: {
      recordType: z.enum(['company', 'deal']).optional().describe('Defaults to deal'),
      fields: z.array(
        z.object({
          id: z.string().describe('Keep the existing id to edit a field; a new one to add it'),
          key: z.string().describe('The exact-case key values are stored under'),
          label: z.string(),
          type: z.enum(['text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect', 'checkbox']),
          required: z.boolean(),
          options: z.array(z.string()).optional().describe('For select/multiselect'),
          order: z.number(),
        }),
      ),
    },
    readOnly: false,
    destructive: true,
    run: (client, { recordType, fields }) =>
      client.request('PUT', '/crm/settings/custom-fields', {
        query: { recordType },
        body: { fields },
        root: true,
      }),
  },
  {
    name: 'get_lost_reasons',
    title: 'Get lost-deal reasons',
    description:
      'Return the configured, selectable reasons for marking a deal lost, and whether picking one is required. Closing a deal as lost otherwise takes a free-text reason, which is how "Sonstiges" (uncategorized) piles up in loss-reason reporting.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/crm/settings/lost-reasons', { root: true }),
  },
  {
    name: 'update_lost_reasons',
    title: 'Update lost-deal reasons',
    description:
      'Replace the entire set of selectable lost-deal reasons — this is a full replace, not a patch: reasons left out of the call are gone, not left alone. Read the current set first. key is what a deal stores and stays stable across relabels; archived hides a reason from new closes without breaking deals already closed under it.',
    schema: {
      reasons: z.array(
        z.object({
          key: z.string().max(64).describe('Stable identifier stored on the deal'),
          label: z.string().max(60).optional().describe('Omit on a built-in reason to keep its translation'),
          archived: z.boolean().optional(),
        }),
      ),
      required: z.boolean().describe('Whether picking a reason is mandatory to mark a deal lost'),
    },
    readOnly: false,
    destructive: true,
    run: (client, body) => client.request('PUT', '/crm/settings/lost-reasons', { body, root: true }),
  },
  {
    name: 'get_company_meeting_history',
    title: "Get a company's meeting history",
    description:
      'Aggregate meeting count, distinct people involved, and the first/last meeting date for a CRM company.',
    schema: { crmCompanyId: z.string() },
    readOnly: true,
    run: (client, { crmCompanyId }) =>
      client.request('GET', `/crm/companies/${crmCompanyId}/meeting-history`, { root: true }),
  },

  // ---- Communications -------------------------------------------------------
  {
    name: 'list_communications',
    title: 'List communications',
    description:
      "List logged communications (WhatsApp, email, call, SMS) for a company, deal or contact, ordered by occurredAt. Exactly one of crmCompanyId, dealId or contactId is required. dealId and contactId are not a strict subset of each other: the API joins through the contact-deal link, so a contact with a communication logged directly at the deal and one logged directly at the contact returns both entries from either scope — confirmed live on a real 1:1 contact/deal pair, unconfirmed how this behaves on a contact with several deals. crmCompanyId stays strict: it only returns entries logged directly against the company, not everything reachable through its deals or contacts.",
    schema: {
      crmCompanyId: z.string().optional(),
      dealId: z.string().optional(),
      contactId: z.string().optional(),
    },
    readOnly: true,
    run: async (client, args) => {
      const { key, value } = exactlyOneScopeId(args)
      if (key === 'dealId') {
        return client.request('GET', `/crm/deals/${value}/communications`, { root: true })
      }
      return client.request('GET', '/crm/communications', { query: { [key]: value }, root: true })
    },
  },
  {
    name: 'create_communication',
    title: 'Log a communication',
    description:
      'Log a communication on a company, deal or contact: a WhatsApp message, email, call or SMS. Exactly one of crmCompanyId, dealId or contactId is required — the API rejects zero or more than one.',
    schema: {
      type: z.enum(COMMUNICATION_TYPES),
      direction: z.enum(COMMUNICATION_DIRECTIONS),
      body: z.string(),
      occurredAt: z.string().describe('ISO 8601'),
      dealId: z.string().optional(),
      contactId: z.string().optional(),
      crmCompanyId: z.string().optional(),
      subject: z.string().optional(),
      durationSeconds: z.number().min(0).optional().describe('Only meaningful for calls'),
      externalId: z.string().optional().describe('ID in the source system, e.g. an email thread id'),
      outcome: z.enum(COMMUNICATION_OUTCOMES).optional().describe('Only meaningful for calls'),
    },
    readOnly: false,
    // async so the guard rejects rather than throwing synchronously, same as
    // create_note's scope check.
    run: async (client, body) => {
      exactlyOneScopeId(body)
      return client.request('POST', '/crm/communications', { body, root: true })
    },
  },
  {
    name: 'update_communication',
    title: 'Update a communication',
    description: 'Correct a logged communication — type, direction, subject, body, duration, outcome or when it occurred. Only supplied fields change.',
    schema: {
      communicationId: z.string(),
      type: z.enum(COMMUNICATION_TYPES).optional(),
      direction: z.enum(COMMUNICATION_DIRECTIONS).optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      durationSeconds: z.number().min(0).optional(),
      outcome: z.enum(COMMUNICATION_OUTCOMES).optional().describe('Only meaningful for calls'),
      occurredAt: z.string().optional().describe('ISO 8601'),
    },
    readOnly: false,
    run: (client, { communicationId, ...body }) =>
      client.request('PATCH', `/crm/communications/${communicationId}`, { body, root: true }),
  },
  {
    name: 'delete_communication',
    title: 'Delete a communication',
    description: 'Permanently delete a logged communication entry.',
    schema: { communicationId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { communicationId }) =>
      client.request('DELETE', `/crm/communications/${communicationId}`, { root: true }),
  },

  // ---- Notes ------------------------------------------------------------
  {
    name: 'list_notes',
    title: 'List notes',
    description:
      'List notes logged against a CRM company, deal or contact, most recent first. Exactly one of crmCompanyId, dealId or contactId is required.',
    schema: {
      crmCompanyId: z.string().optional(),
      dealId: z.string().optional(),
      contactId: z.string().optional(),
    },
    readOnly: true,
    // async so the scope guard rejects rather than throwing synchronously,
    // same as get_contact's contactId/attendeeId check.
    run: async (client, args) =>
      client.request('GET', scopedCrmPath(args, 'notes'), { root: true }),
  },
  {
    name: 'create_note',
    title: 'Log a note',
    description:
      'Log a note against a CRM company, contact or deal. Exactly one of crmCompanyId, contactId or dealId is required — the API rejects zero or more than one.',
    schema: {
      content: z.string(),
      isPinned: z.boolean().optional().describe('Pin the note to the top'),
      crmCompanyId: z.string().optional(),
      contactId: z.string().optional(),
      dealId: z.string().optional(),
    },
    readOnly: false,
    // async so the guard rejects rather than throwing synchronously, same as
    // get_contact's contactId/attendeeId check.
    run: async (client, args) => {
      exactlyOneScopeId(args)
      return client.request('POST', '/crm/notes', { body: args, root: true })
    },
  },
  {
    name: 'update_note',
    title: 'Update a note',
    description:
      "Change a logged note's content, or pin it to the top of the company/deal/contact's note list. Only supplied fields change.",
    schema: {
      noteId: z.string(),
      content: z.string().optional(),
      isPinned: z.boolean().optional(),
    },
    readOnly: false,
    run: (client, { noteId, ...body }) =>
      client.request('PATCH', `/crm/notes/${noteId}`, { body, root: true }),
  },
  {
    name: 'delete_note',
    title: 'Delete a note',
    description: 'Permanently delete a logged note. There is no undo.',
    schema: { noteId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { noteId }) =>
      client.request('DELETE', `/crm/notes/${noteId}`, { root: true }),
  },

  // ---- Attachments --------------------------------------------------------
  {
    name: 'list_attachments',
    title: 'List attachments',
    description:
      "List attachments on a CRM company, deal or contact. Exactly one of crmCompanyId, dealId or contactId is required. There is no create_attachment yet: the API needs a fileAssetId from an upload step whose endpoint has not been located — and a company-scoped upload route that looked promising turned out to be a stub that reports success without saving anything.",
    schema: {
      crmCompanyId: z.string().optional(),
      dealId: z.string().optional(),
      contactId: z.string().optional(),
    },
    readOnly: true,
    run: async (client, args) =>
      client.request('GET', scopedCrmPath(args, 'attachments'), { root: true }),
  },

  // ---- Tasks --------------------------------------------------------------
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'List CRM tasks, paginated with page and limit. crmCompanyId, dealId and contactId scope to one parent; unconfirmed as server-side filters, but harmless to pass on a GET.',
    schema: {
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).optional(),
      crmCompanyId: z
        .string()
        .optional()
        .describe('Unconfirmed as a filter here — list_company_tasks uses the confirmed endpoint instead'),
      dealId: z.string().optional(),
      contactId: z.string().optional(),
    },
    readOnly: true,
    run: (client, args) => client.request('GET', '/crm/tasks', { query: args, root: true }),
  },
  {
    name: 'get_task',
    title: 'Get a task',
    description: 'Return a single CRM task by id, with its assignee and linked company.',
    schema: { taskId: z.string() },
    readOnly: true,
    run: (client, { taskId }) => client.request('GET', `/crm/tasks/${taskId}`, { root: true }),
  },
  {
    name: 'get_task_summary',
    title: 'Get task summary',
    description:
      'Aggregate task counts: total, completed, overdue, due today, due this week, and breakdowns by type and priority. The API spec marks assigneeId required; live-confirmed that omitting it is not an error — it returns the aggregate across every assignee. Pass it to scope down to one.',
    schema: { assigneeId: z.string().optional() },
    readOnly: true,
    run: (client, args) => client.request('GET', '/crm/tasks/summary', { query: args, root: true }),
  },
  {
    name: 'list_overdue_tasks',
    title: 'List overdue tasks',
    description: 'List open tasks whose due date has already passed, most relevant first.',
    schema: {},
    readOnly: true,
    run: (client) => client.request('GET', '/crm/tasks/overdue', { root: true }),
  },
  {
    name: 'list_upcoming_tasks',
    title: 'List upcoming tasks',
    description:
      'List open tasks due within the next few days. The API spec marks days required; live-confirmed that omitting it is not an error — it returns upcoming tasks on whatever window the API defaults to.',
    schema: { days: z.number().int().min(1).optional().describe('Window size in days') },
    readOnly: true,
    run: (client, args) => client.request('GET', '/crm/tasks/upcoming', { query: args, root: true }),
  },
  {
    name: 'list_company_tasks',
    title: "Get a company's tasks",
    description:
      "List tasks linked to a CRM company, on its own confirmed endpoint — the flat listing tool's crmCompanyId filter was never confirmed to actually filter anything.",
    schema: { crmCompanyId: z.string() },
    readOnly: true,
    run: (client, { crmCompanyId }) =>
      client.request('GET', `/crm/tasks/by-company/${crmCompanyId}`, { root: true }),
  },
  {
    name: 'create_task',
    title: 'Create a task',
    description:
      'Create a CRM task, optionally linked to a company, deal or contact. type is checked server-side, not here — confirmed values are call, follow_up, email, meeting and todo, but the API may accept others the server never tried; an invalid value comes back as the API\'s own "type must be a valid enum value". A bad crmCompanyId/dealId/contactId is validated too and comes back as its own 400, e.g. "Deal not found or does not belong to your company".',
    schema: {
      title: z.string(),
      type: z.string().describe('e.g. call, follow_up, email, meeting or todo'),
      dueDate: z.string().describe('ISO 8601'),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Defaults to medium'),
      reminderAt: z.string().optional().describe('ISO 8601, separate from dueDate'),
      assigneeId: z.string().optional(),
      assigneeIds: z
        .array(z.string())
        .optional()
        .describe('Everyone the task is offered to; any of them can take it. assigneeId, when on the list, is the primary, otherwise the first id is.'),
      sourceRef: z
        .string()
        .max(200)
        .regex(/^[a-z]+:[A-Za-z0-9:._-]+$/)
        .optional()
        .describe('Where the task came from, e.g. notetaker:<session>:<item>'),
      crmCompanyId: z.string().optional(),
      dealId: z.string().optional(),
      contactId: z.string().optional(),
    },
    readOnly: false,
    run: (client, body) => client.request('POST', '/crm/tasks', { body, root: true }),
  },
  {
    name: 'update_task',
    title: 'Update a task',
    description:
      'Update a CRM task. Only supplied fields change. completed, status, isCompleted and completedAt are silently ignored here — the API accepts them with HTTP 200 but never applies them; mark a task done or reopen it with the dedicated complete/reopen tools instead.',
    schema: {
      taskId: z.string(),
      title: z.string().optional(),
      type: z.string().optional().describe('e.g. call, follow_up, email, meeting or todo'),
      dueDate: z.string().optional().describe('ISO 8601'),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      reminderAt: z.string().optional().describe('ISO 8601, separate from dueDate'),
      assigneeId: z.string().optional(),
      assigneeIds: z.array(z.string()).optional().describe('Replaces the people the task is offered to'),
      crmCompanyId: z.string().optional(),
      dealId: z.string().nullable().optional(),
      contactId: z.string().nullable().optional(),
    },
    readOnly: false,
    run: (client, { taskId, ...body }) =>
      client.request('PATCH', `/crm/tasks/${taskId}`, { body, root: true }),
  },
  {
    name: 'complete_task',
    title: 'Mark a task done',
    description:
      'Mark a task complete via its own endpoint. No body: the API sets completed and completedAt itself.',
    schema: { taskId: z.string() },
    readOnly: false,
    run: (client, { taskId }) =>
      client.request('PATCH', `/crm/tasks/${taskId}/complete`, { root: true }),
  },
  {
    name: 'uncomplete_task',
    title: 'Reopen a completed task',
    description: 'Undo a completed task, clearing completed and completedAt. No body needed.',
    schema: { taskId: z.string() },
    readOnly: false,
    run: (client, { taskId }) =>
      client.request('PATCH', `/crm/tasks/${taskId}/uncomplete`, { root: true }),
  },
  {
    name: 'delete_task',
    title: 'Delete a task',
    description: 'Permanently delete a task. There is no undo.',
    schema: { taskId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { taskId }) =>
      client.request('DELETE', `/crm/tasks/${taskId}`, { root: true }),
  },
  {
    name: 'log_personal_followup',
    title: 'Log a personal follow-up conversation',
    description:
      "Log a personal conversation as a fixed, labeled note (Anliegen/Kontext/Zusage) plus a linked reminder task, instead of leaving the hard facts a later message needs — the concern raised, the promise made and its deadline — to whatever free text an agent happens to write. That structure is what lets a later draft-composing step check there is enough real, specific context before it writes anything, rather than inventing warmth. Defaults the reminder to 30 days out when no explicit date is given. Once the follow-up message is actually sent, close the reminder out with the dedicated complete endpoint rather than deleting it — that status is confirmed to persist now, so deleting would throw the record away for no reason. These are two sequential writes with no transaction across them: when the note is logged but the linked task then fails to create, the result comes back (not thrown) with taskCreated false, the note already saved, and a ready-to-use suggestedTask payload — pass that straight to the dedicated task-creation tool before moving on. Do not call this one again for the same conversation, that logs it a second time. Skipping the follow-up call leaves a note with no linked reminder that nothing else surfaces — treat taskCreated false as something to act on immediately, not just a status to note.",
    schema: {
      contactId: z.string(),
      need: z.string().describe('The concern or ask the other person raised, concretely — not a vague summary'),
      context: z.string().optional().describe('Any other context worth keeping about the conversation'),
      commitment: z.string().describe('The promise made, e.g. "melde mich mit einem Angebot"'),
      commitmentDueDate: z
        .string()
        .optional()
        .describe('ISO 8601 date — deadline for the promise itself, if one was actually given'),
      followUpDueDate: z
        .string()
        .optional()
        .describe('ISO 8601 — due date for the reminder task. Defaults to 30 days from now.'),
      contactName: z
        .string()
        .optional()
        .describe('Used only for the reminder task title; omitted, the title falls back to the contact id'),
    },
    readOnly: false,
    run: async (client, args) => {
      const followUpDueDate =
        args.followUpDueDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      const content = [
        `Anliegen: ${args.need}`,
        args.context ? `Kontext: ${args.context}` : undefined,
        `Zusage: ${args.commitment}${args.commitmentDueDate ? ` (bis ${args.commitmentDueDate})` : ''}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')

      const note = await client.request('POST', '/crm/notes', {
        body: { content, contactId: args.contactId },
        root: true,
      })

      const taskBody = {
        title: `Persönlich nachfassen: ${args.contactName ?? args.contactId}`,
        type: 'follow_up',
        dueDate: followUpDueDate,
        description: content,
        contactId: args.contactId,
      }

      // Two sequential writes, no transaction across them. The note is the
      // conversation record a person already gave once — if the linked task
      // then fails (timeout, rate limit), surface that instead of throwing a
      // generic error that hides the fact the note went through, and don't
      // roll the note back either: deleting it risks a second failure on the
      // same transient cause, for no gain over just retrying the task alone.
      // taskBody comes back as suggestedTask so the caller can create it with
      // no reconstruction — a flag alone is too easy to leave unactioned.
      try {
        const task = await client.request('POST', '/crm/tasks', { body: taskBody, root: true })
        return { note, task, content, followUpDueDate, taskCreated: true }
      } catch (err) {
        return {
          note,
          task: null,
          content,
          followUpDueDate,
          taskCreated: false,
          taskError: err instanceof Error ? err.message : String(err),
          suggestedTask: taskBody,
        }
      }
    },
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

  // ---- Per-area modules (docs, availability, spaces, engagement, booking setup, invoicing)
  ...DOCS_TOOLS,
  ...AVAILABILITY_TOOLS,
  ...SPACES_TOOLS,
  ...ENGAGEMENT_TOOLS,
  ...BOOKING_SETUP_TOOLS,
  ...INVOICING_TOOLS,
]
