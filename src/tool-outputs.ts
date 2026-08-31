/**
 * Output schemas, one per tool, and the rule that turns a tool's return value
 * into the `structuredContent` the schema is checked against.
 *
 * Why they exist: the ChatGPT app review flags every tool without an
 * `outputSchema`, and hosts use the schema to explain a result to the model.
 * Why they are shaped the way they are: the MCP SDK REJECTS a tool call whose
 * `structuredContent` fails its `outputSchema`, so a schema that is stricter
 * than the API's real response turns a working tool into a protocol error in
 * production. Every schema here therefore
 *
 *   - is `.passthrough()`: fields the API adds later are fine,
 *   - marks every field the API owns as optional and nullable, so a missing or
 *     null value never fails,
 *   - types a field only when the type is certain; anything doubtful is
 *     `unknown` with a description.
 *
 * Fields this server computes itself (`slotsStartUtc`, `bookingState`, the
 * setup checklist, the widget snippet) are typed exactly — the code that
 * produces them is next to the schema and the tests hold them together.
 *
 * `toStructuredContent` is the other half of the contract: a schema must be an
 * object, but list endpoints return arrays and deletes return nothing, so the
 * server wraps those. The text content keeps the raw shape — this affects only
 * the structured mirror.
 */
import { z } from 'zod'

const str = z.string().nullable().optional()
const bool = z.boolean().nullable().optional()
const num = z.number().nullable().optional()
const any = (description: string) => z.unknown().optional().describe(description)
const record = z.object({}).passthrough()
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().optional()

function out(shape: z.ZodRawShape, description: string) {
  return z.object(shape).passthrough().describe(description)
}

const ok = out(
  {
    ok: z.boolean().nullable().optional().describe('true when the API returned an empty success'),
  },
  'Empty success. Any fields present are what the API echoed back.',
)

const meetingInfo = out(
  {
    name: str,
    description: str,
    duration: num.describe('Minutes'),
    channel: str,
    bufferBefore: num,
    bufferAfter: num,
    color: str,
  },
  'Booking-page settings of the meeting type',
)

const meetingType = out(
  {
    id: str,
    slug: str.describe('URL segment of the public booking page'),
    userId: str.describe('Host, for a single-host type'),
    queueId: str.describe('Round-robin queue, when the type is shared'),
    spots: num.describe('Attendees per slot'),
    meetingInfo: meetingInfo.nullable().optional(),
  },
  'A bookable meeting type',
)

const attendee = out(
  {
    id: str.describe('The attendeeId other tools take'),
    email: str,
    firstname: str,
    lastname: str,
    fullname: str,
    phone: str,
    timezone: str,
  },
  'A person on an appointment',
)

const appointment = out(
  {
    id: str,
    start: str.describe('Start, ISO 8601'),
    end: str.describe('End, ISO 8601'),
    status: z
      .enum(['confirmed', 'cancelled'])
      .nullable()
      .optional()
      .describe('Derived by this server: never report a cancelled appointment as upcoming'),
    rescheduled: bool.describe('Present and true when the appointment was moved at least once'),
    isCancelled: bool,
    meetingTypeId: str,
    attendees: list(attendee),
    hosts: list(record),
    location: any('Where the meeting happens, as configured on the meeting type'),
    notes: any('Host-side note and booking-form answers'),
  },
  'An appointment with its derived status',
)

const contact = out(
  {
    id: str.describe('The contactId other tools take'),
    firstName: str,
    lastName: str,
    email: str,
    phoneNumber: str,
    tags: list(z.unknown()),
    notes: str,
    accountOwnerId: str,
    createdAt: str,
  },
  'A CRM contact',
)

const pipelineStage = out(
  {
    id: str,
    name: str,
    color: str,
    order: num,
    isWon: bool,
    isLost: bool,
    winProbability: num,
    rottingDays: num,
    requiredCustomFields: list(z.string()),
    pipelineId: str,
  },
  'A stage within a pipeline',
)

const pipeline = out(
  {
    id: str.describe('The pipelineId other tools take'),
    name: str,
    isDefault: bool,
    companyId: str,
    stages: list(pipelineStage),
    createdAt: str,
    updatedAt: str,
  },
  'A sales pipeline with its stages',
)

const deal = out(
  {
    id: str.describe('The dealId other tools take'),
    name: str,
    value: num,
    currency: str,
    expectedCloseDate: str,
    notes: str,
    crmCompanyId: str,
    contactId: str,
    pipelineId: str,
    stageId: str,
    ownerId: str,
    companyId: str,
    lostReason: str,
    lostReasonNote: str,
    wonAt: str,
    lostAt: str,
    enteredStageAt: str,
    isRotting: bool,
    customFields: record.nullable().optional(),
    crmCompany: record.nullable().optional(),
    contact: record.nullable().optional(),
    stage: record.nullable().optional(),
    owner: record.nullable().optional(),
    contacts: list(record),
    createdAt: str,
    updatedAt: str,
  },
  'A CRM deal',
)

const dealActivity = out(
  {
    id: str,
    dealId: str,
    activityType: str,
    fromStageId: str,
    fromStageName: str,
    toStageId: str,
    toStageName: str,
    changedById: str.describe('Null when automation changed a deal with no owner'),
    changedByName: str,
    metadata: record.nullable().optional(),
    changedAt: str,
  },
  'One deal activity or stage-change event',
)

const routingForm = out(
  {
    id: str.describe('The formId other tools take'),
    name: str,
    slug: str,
    structureType: str,
    publicUrl: str,
    showProgressBar: bool,
    skipForm: bool,
    fields: any('Fields shown on the form'),
    funnelSteps: any('Funnel steps, each with its own fields'),
    qualifiers: any('Routing rules and their destinations'),
  },
  'A routing form or funnel',
)

const dataField = out(
  {
    id: str,
    label: str,
    name: str.describe('Internal key'),
    fieldType: str,
    required: bool,
    options: any('Choices, for choice fields'),
    target: str,
  },
  'A reusable form field',
)

const webhook = out(
  {
    id: str.describe('The webhookId other tools take'),
    endpoint: str,
    eventTypes: list(z.string()),
    description: str,
    createdAt: str,
  },
  'A webhook subscription',
)

const miraSettings = out(
  {
    enabled: bool.describe('Company-wide master switch'),
    customInstructions: str,
    dataAccess: record.nullable().optional(),
    webChat: out(
      {
        enabled: bool.describe('Widget live on the public website'),
        publicKey: str.describe('Server-minted embed key'),
        assistantName: str,
        welcomeMessage: str,
        allowedDomains: list(z.string()),
        routingFormId: str,
        bookingMeetingTypeId: str,
        qualify: bool,
        useKnowledge: bool,
        aiDisclosure: bool,
        privacyPolicyUrl: str,
        imprintUrl: str,
      },
      'Website chat widget',
    )
      .nullable()
      .optional(),
    assistantProfiles: list(record),
    channels: record.nullable().optional(),
    lastTestDrive: any('Stored verdict of the last test drive'),
  },
  "The company's resolved Mira configuration",
)

const knowledgeDocument = out(
  {
    id: str.describe('The documentId delete_knowledge_document takes'),
    title: str,
    source: str,
    sourceKey: str,
    url: str,
    createdAt: str,
  },
  'A knowledge-base document',
)

const knowledgeChunk = out(
  {
    documentId: str,
    title: str,
    sourceKey: str,
    content: str,
    text: str,
    score: any('Retrieval score, higher is closer'),
  },
  'One retrieved knowledge chunk',
)

const formRecipient = out(
  {
    id: str,
    recipientName: str,
    email: str,
    phone: str,
    status: str.describe('sent, opened or completed'),
    sentAt: str,
    openedAt: str,
    completedAt: str,
  },
  'Someone a routing form was sent to',
)

/** List endpoints: a bare array is wrapped as `items`; paginated ones keep their keys. */
function listOf<T extends z.ZodTypeAny>(item: T, description: string) {
  return out(
    {
      items: list(item).describe('The results, when the API returns a plain list'),
      data: list(item).describe('The results, when the API paginates'),
      total: any('Total matches, when the API paginates'),
      page: any('Current page, when the API paginates'),
    },
    description,
  )
}

const setupStepKey = z.enum([
  'bookable',
  'assistant',
  'knowledge',
  'testDrive',
  'install',
  'live',
])

export const TOOL_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  get_me: out(
    {
      id: str.describe('userId'),
      email: str,
      firstName: str,
      lastName: str,
      companyId: str,
      timezone: str,
      plan: record
        .nullable()
        .optional()
        .describe('Plan tier and the caps that gate individual actions, when the API exposes it'),
    },
    'The authenticated account',
  ),
  list_meeting_types: listOf(meetingType, 'Meeting types the account can book'),
  get_availability: out(
    {
      timezone: str,
      slotsStartUtc: z
        .array(z.string())
        .nullable()
        .optional()
        .describe('Every bookable start, ISO 8601 UTC, sorted and deduplicated. Book only from this list.'),
      dates: list(
        out(
          { date: str, spots: any('Raw per-day slots as the API returned them') },
          'One day of availability',
        ),
      ),
    },
    'Bookable slots for the requested window',
  ),
  book_appointment: out(
    {
      bookingState: z
        .enum(['confirmed', 'pending_confirmation'])
        .nullable()
        .optional()
        .describe('confirmed means the appointment exists; pending_confirmation means it does NOT yet'),
      startUtc: str.describe('The booked start, ISO 8601 UTC (confirmed only)'),
      message: str.describe('What still has to happen (pending only)'),
      id: str.describe('appointmentId (confirmed only)'),
      provisionalBookingId: str,
      bookingType: str,
    },
    'Outcome of the booking attempt',
  ),
  reschedule_appointment: out(
    {
      bookingState: z.literal('confirmed').nullable().optional(),
      startUtc: str.describe('The new start, ISO 8601 UTC'),
      appointment: appointment.nullable().optional(),
    },
    'The moved appointment',
  ),
  cancel_appointment: out(
    {
      bookingState: z.enum(['cancelled', 'attendee_removed']).nullable().optional(),
      status: str,
      removedAttendeeId: str.describe('Set when a single attendee was removed'),
      id: str,
    },
    'Outcome of the cancellation',
  ),
  list_appointments: out(
    {
      appointments: list(appointment),
      total: any('Total matches'),
      page: any('0-indexed page'),
      pageSize: any('Page size'),
    },
    'One page of appointments',
  ),
  get_todays_appointments: out(
    {
      items: list(appointment),
      appointments: list(appointment),
    },
    "Today's appointments, each with a derived status",
  ),
  get_appointment: appointment,
  add_guest: out(
    { id: str, attendees: list(attendee) },
    'The appointment after the guest was added',
  ),
  update_appointment_notes: out(
    { id: str, note: str },
    'The appointment after the note was replaced',
  ),
  create_one_time_booking_link: out(
    {
      id: str,
      url: str.describe('The single-use booking URL'),
      link: str.describe('The single-use booking URL, when named so by the API'),
      token: str,
    },
    'A fresh single-use booking link',
  ),
  search_contacts: listOf(contact, 'Matching CRM contacts'),
  get_contact: out(
    {
      ...contact.shape,
      appointments: list(record).describe('Linked appointments'),
      formAnswers: any('Answers the contact gave on routing forms'),
    },
    'A CRM contact with linked appointments and form answers',
  ),
  create_contact: contact,
  update_contact: contact,
  list_calendar_connections: listOf(
    out(
      { id: str, provider: str.describe('google, microsoft, caldav …'), email: str },
      'A connected calendar account',
    ),
    'Calendar accounts connected to the user',
  ),
  send_quick_email: ok,
  update_meeting_transcription: out(
    { id: str, transcription: str, summary: str },
    'The appointment after the transcript fields changed',
  ),
  get_meeting_type: meetingType,
  create_meeting_type: meetingType,
  update_meeting_type: meetingType,
  delete_meeting_type: ok,
  get_personal_page: out(
    {
      id: str,
      useCustomColors: bool,
      primaryColor: str,
      secondaryColor: str,
      headerImage: str,
      description: str,
      showAllMeetingTypes: bool,
      meetingTypeOrder: list(z.string()),
      onlineProfiles: record.nullable().optional(),
    },
    "The user's personal booking page settings",
  ),
  update_personal_page: out(
    {
      id: str,
      useCustomColors: bool,
      primaryColor: str,
      secondaryColor: str,
      headerImage: str,
      description: str,
      showAllMeetingTypes: bool,
      meetingTypeOrder: list(z.string()),
      onlineProfiles: record.nullable().optional(),
    },
    'The booking page after the update',
  ),
  import_booking_page: out(
    {
      provider: str.describe('Scheduler recognised from the URL'),
      created: any('Meeting types created from the imported page'),
      failed: any('Event types that could not be imported, with the reason'),
    },
    'What the import created and what it could not',
  ),
  list_routing_forms: listOf(routingForm, 'Routing forms and funnels'),
  get_routing_form: routingForm,
  create_routing_form: routingForm,
  update_routing_form: routingForm,
  delete_routing_form: ok,
  send_routing_form: out(
    {
      publicUrl: str.describe('The link the recipient gets, always present'),
      deliveryMethod: str,
      recipientId: str,
      status: str,
    },
    'Delivery result for the routing form',
  ),
  list_form_recipients: out(
    { items: list(formRecipient), recipients: list(formRecipient) },
    'Who the form was sent to and how far they got',
  ),
  list_data_fields: listOf(dataField, 'Reusable form fields'),
  create_data_field: dataField,
  bulk_create_contacts: out(
    {
      items: any('Created contacts, when the API returns a plain list'),
      created: any('Created contacts or their count'),
      failed: any('Rows that were rejected, with the reason'),
    },
    'Result of the bulk import',
  ),
  delete_contact: ok,
  list_pipelines: listOf(pipeline, 'Sales pipelines and their stages'),
  list_deals: out(
    {
      deals: list(deal),
      total: any('Total matches'),
      page: any('Current page'),
      limit: any('Page size'),
      totalPages: any('Total pages'),
    },
    'Paginated deals',
  ),
  get_deal: deal,
  create_deal: deal,
  update_deal: deal,
  delete_deal: ok,
  mark_deal_won: deal,
  mark_deal_lost: deal,
  reopen_deal: deal,
  get_deal_activity: listOf(dealActivity, "A deal's activity log, most recent first"),
  list_webhooks: listOf(webhook, 'Webhook subscriptions of the company'),
  create_webhook: webhook,
  update_webhook: webhook,
  delete_webhook: ok,
  get_mira_settings: miraSettings,
  update_mira_settings: out(
    {
      previous: miraSettings.nullable().optional().describe('Snapshot before the change — keep it for restore_mira_settings'),
      current: miraSettings.nullable().optional().describe('Settings after the change'),
    },
    'Before and after the update',
  ),
  restore_mira_settings: miraSettings,
  get_mira_widget_embed: out(
    {
      publicKey: z.string(),
      enabled: z.boolean().describe('Whether the widget is live'),
      allowedDomains: z.array(z.string()),
      loaderUrl: z.string(),
      snippet: z.string().describe('Paste before </body>'),
      widgetPageUrl: z.string(),
      previewUrl: z.string().describe('Works while the widget is still disabled'),
    },
    'The install snippet and preview URL',
  ),
  crawl_company_website: out(
    {
      status: str,
      jobId: str,
      message: str,
    },
    'Acknowledgement that the crawl started',
  ),
  get_crawl_status: out(
    {
      status: str.describe('idle when no crawl has run yet'),
      url: str,
      pagesCrawled: any('Pages read so far'),
      pagesIngested: any('Pages added to the knowledge base'),
      startedAt: str,
      finishedAt: str,
      error: str,
    },
    'Progress of the current or last crawl',
  ),
  list_knowledge_documents: out(
    { documents: list(knowledgeDocument), items: list(knowledgeDocument) },
    'Documents in the knowledge base',
  ),
  delete_knowledge_document: ok,
  propose_conversion_setup: out(
    {
      profile: any('Proposed assistant persona'),
      welcomeMessage: str,
      instructions: str,
      questions: any('Qualification questions, ready for create_qualification_form'),
      quickActions: any('Suggested quick actions'),
      privacyPolicyUrl: str,
      imprintUrl: str,
      knowledgeProbe: any('Questions to verify grounded answers with'),
    },
    'A proposed assistant setup. Nothing is saved.',
  ),
  answer_visitor_question: out(
    { id: str, documentId: str, question: str, answer: str },
    'The stored question-and-answer pair',
  ),
  get_conversation_insights: out(
    {
      days: any('Window in days'),
      unansweredQuestions: any('Questions visitors asked that the assistant could not answer'),
      conversations: any('Recent conversation activity'),
      stats: any('Aggregate counts for the window'),
    },
    'Recent website chat activity and its gaps',
  ),
  search_company_knowledge: out(
    {
      items: list(knowledgeChunk),
      results: list(knowledgeChunk),
      chunks: list(knowledgeChunk),
    },
    'Chunks the assistant would retrieve for the query',
  ),
  get_setup_status: out(
    {
      stage: z.enum(['fresh', 'ready', 'live']),
      steps: z.array(
        out(
          {
            key: setupStepKey,
            done: z.boolean(),
            action: z.string().describe('The next move when not done'),
          },
          'One checklist step',
        ),
      ),
      done: z.number().int().describe('Steps done'),
      total: z.number().int(),
      next: setupStepKey.nullable().describe('First unmet step, null when live'),
    },
    'The launch checklist',
  ),
  create_qualification_form: out(
    {
      formId: str.describe('Point the assistant profile at this'),
      id: str,
      slug: str,
      publicUrl: str,
      name: str,
    },
    'The routing form created from the questions',
  ),
  run_test_drive: out(
    {
      passed: bool.describe('Overall verdict'),
      verdicts: any('Per-scenario pass/fail'),
      results: any('Per-scenario results with transcripts'),
      transcripts: any('Full conversations'),
    },
    'Verdicts and transcripts of the scripted visitors',
  ),
  verify_widget_install: out(
    {
      installed: z.boolean().describe('true only when loader AND this account key are present'),
      foundLoader: bool,
      foundKey: bool,
      checkedUrl: str.describe('The URL actually fetched, after redirects'),
      error: str,
      hint: str.describe('What to fix when not installed'),
    },
    'Whether the page serves this account’s widget',
  ),
}

/**
 * The value the output schema is checked against. Objects pass through; a
 * list becomes `{ items }`, an empty result `{ ok: true }`, a bare value
 * `{ value }`. Text content is unaffected.
 */
export function toStructuredContent(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return { ok: true }
  if (Array.isArray(result)) return { items: result }
  if (typeof result === 'object') return result as Record<string, unknown>
  return { value: result }
}
