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
import { z } from 'zod/v3'
import { any, bool, list, num, numOrStr, out, record, str } from './output-helpers.js'
import { DOCS_OUTPUTS } from './tools-docs.js'
import { AVAILABILITY_OUTPUTS } from './tools-availability.js'
import { SPACES_OUTPUTS } from './tools-spaces.js'
import { ENGAGEMENT_OUTPUTS } from './tools-engagement.js'
import { BOOKING_SETUP_OUTPUTS } from './tools-booking-setup.js'
import { INVOICING_OUTPUTS } from './tools-invoicing.js'
import { PLAN_OUTPUTS } from './plan-access.js'

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
    crmCompanyId: str,
    language: str.describe('ISO 639-1, e.g. de'),
    address: record.nullable().optional(),
    title: str.describe('Research-suggested until a person edits it'),
    employer: str,
    seniority: str,
    function: str,
    location: str,
    additionalData: record.nullable().optional().describe('Custom field values, keyed by name from list_data_fields'),
    createdAt: str,
  },
  'A CRM contact',
)

const contactSummary = out(
  {
    contactId: str,
    firstName: str,
    lastName: str,
    email: str,
    phoneNumber: str,
    crmCompanyId: str,
  },
  'A compact contact reference within a duplicate group',
)

const duplicateContactGroup = out(
  {
    reason: str.describe('email, phone or name'),
    key: str.describe('The normalized value the group matched on'),
    contacts: list(contactSummary),
  },
  'Contacts that share a normalized email, phone or name',
)

const quietDeal = out(
  {
    dealId: str,
    dealName: str,
    value: num,
    currency: str,
    pipelineId: str,
    stageId: str,
    enteredStageAt: str,
    isRotting: bool,
    daysSinceLastActivity: num,
    healthBand: str,
    followUpsSinceLastReply: num,
    contactId: str,
    contactFirstName: str,
    contactLastName: str,
    contactEmail: str,
    crmCompanyId: str,
    contactSourceType: numOrStr.describe(
      'Read from the contact additionalData key named by contactSourceField; null until that custom data field exists on the account',
    ),
  },
  'An open deal that has gone quiet, with its server-computed health signal',
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
    salesMilestone: str.describe('start, demo or offer, when set — feeds the Sales Learning report'),
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

const dealSignal = out(
  {
    healthScore: num,
    healthBand: str.describe('e.g. on_track'),
    daysInStage: num,
    daysSinceLastActivity: num,
    daysSinceLastInbound: num,
    daysSinceLastOutbound: num,
    followUpsSinceLastReply: num,
    hasReplyEver: bool,
    inboundCount: num,
    outboundCount: num,
    meetingsBooked: num,
    meetingsHeld: num,
    openTaskCount: num,
    overdueTaskCount: num,
    computedAt: str,
  },
  'Server-computed deal health, attached to every deal read',
)

const dealContact = out(
  {
    id: str.describe('The dealContactId update_deal_contact/remove_deal_contact take'),
    dealId: str,
    contactId: str,
    role: str.describe('primary, decision_maker, influencer, user or other'),
    isPrimary: bool,
    contact: record.nullable().optional(),
    createdAt: str,
  },
  "One contact's link to a deal, with its role",
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
    signal: dealSignal.nullable().optional(),
    createdAt: str,
    updatedAt: str,
  },
  'A CRM deal',
)

const company = out(
  {
    id: str.describe('The crmCompanyId other tools take'),
    name: str,
    domain: str,
    industry: str,
    size: str.describe('1-10, 11-50, 51-200, 201-500, 501-1000 or 1001+'),
    website: str,
    phoneNumber: str,
    address: record.nullable().optional(),
    notes: str,
    ownerId: str,
    companyId: str.describe('The meetergo tenant id owning this record, not the CRM company itself'),
    customFields: record.nullable().optional(),
    owner: record.nullable().optional(),
    contactsCount: num,
    dealsCount: num,
    totalDealsValue: num,
    createdAt: str,
    updatedAt: str,
  },
  'A CRM company',
)

const communication = out(
  {
    id: str,
    type: str.describe('whatsapp, email, call or sms'),
    direction: str.describe('inbound or outbound'),
    subject: str,
    body: str,
    durationSeconds: num,
    outcome: str,
    externalId: str,
    dealId: str,
    contactId: str,
    crmCompanyId: str,
    loggedById: str,
    loggedByName: str,
    occurredAt: str,
    createdAt: str,
    updatedAt: str,
  },
  'A logged communication (WhatsApp, email, call or SMS) on a company, deal or contact',
)

const contactActivityItem = out(
  {
    id: str,
    type: str.describe('meeting, email, form, note, task, communication or conversation'),
    source: str,
    occurredAt: str,
    title: str,
    summary: str,
    direction: str,
    status: str,
    owner: record.nullable().optional(),
    deal: record.nullable().optional(),
    recordingSessionId: str.describe("This entry's meeting recording, when there is one"),
  },
  "One entry in a contact's unified activity timeline",
)

const crmEmail = out(
  {
    id: str.describe('The emailId get_email_body takes'),
    externalMessageId: str,
    threadId: str,
    subject: str,
    snippet: str,
    fromEmail: str,
    toEmails: list(z.string()),
    direction: str,
    sentAt: str,
    provider: str,
    contactId: str,
    dealId: str,
    providerUrl: str.describe('Deep link to open in Gmail or Outlook'),
    createdAt: str,
  },
  'A synced email — header and preview only, no body',
)

const note = out(
  {
    id: str,
    content: str,
    isPinned: bool,
    dealId: str,
    contactId: str,
    crmCompanyId: str,
    authorId: str,
    createdAt: str,
    updatedAt: str,
  },
  'A note logged against a company, contact or deal',
)

const task = out(
  {
    id: str.describe('The taskId other tools take'),
    title: str,
    description: str,
    type: str.describe('e.g. call, follow_up, email or meeting'),
    priority: str,
    dueDate: str,
    reminderAt: str,
    completed: bool.describe('Set via complete_task/uncomplete_task, not update_task'),
    completedAt: str,
    assigneeId: str,
    companyId: str.describe("The meetergo tenant's own account id, not the CRM company"),
    crmCompanyId: str.describe('The linked CRM company, when set'),
    dealId: str.describe('The linked deal, when set'),
    contactId: str.describe('The linked contact, when set'),
    isOverdue: bool,
    crmCompany: record.nullable().optional(),
    deal: record.nullable().optional(),
    contact: record.nullable().optional(),
    assignee: record.nullable().optional(),
    createdAt: str,
    updatedAt: str,
  },
  'A CRM task',
)

// Never observed populated during research — every company checked had an
// empty attachments list — so the shape of a real entry is unconfirmed.
const attachment = record.describe('An attachment on a company; fields unconfirmed, never seen populated')

const customFieldDefinition = out(
  {
    id: str,
    key: str.describe('The exact-case key to write under customFields'),
    label: str,
    type: str.describe('e.g. multiselect'),
    required: bool,
    options: list(z.string()).describe('Valid values, for a multiselect field'),
    order: num,
  },
  'A custom field configured on CRM companies or deals',
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
    id: numOrStr,
    label: str,
    name: str.describe('The exact key customFields expects when writing to this field'),
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
  search_contacts: out(
    {
      result: list(contact),
      total: any('Total matches'),
      page: any('Current page'),
      limit: any('Page size'),
      totalPages: any('Total pages'),
    },
    'Paginated matching CRM contacts',
  ),
  find_duplicate_contacts: out(
    {
      totalContactsScanned: num,
      duplicateGroups: list(duplicateContactGroup),
    },
    'Contacts grouped by likely duplicate, computed client-side',
  ),
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
  set_contact_source_type: out(
    {
      contactId: str,
      contactSourceField: str,
      value: str,
      fieldCreated: bool.describe('true when the backing custom data field had to be created on this call'),
    },
    'Result of tagging a contact with an account-defined source-type flag, provisioning the backing field if needed',
  ),
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
  update_data_field: dataField,
  delete_data_field: ok,
  get_data_field_usage: record.describe('Where this field is actually used; shape unconfirmed'),
  reorder_data_fields: listOf(dataField, 'The fields in their new order'),
  bulk_create_contacts: out(
    {
      created: num.describe('Newly inserted contacts'),
      updated: num.describe('Existing contacts updated in place, only when updateExisting is true'),
      skipped: num.describe('Existing/duplicate contacts left untouched'),
      failed: num,
      issues: list(record),
    },
    'Result counts from the bulk contact import',
  ),
  delete_contact: ok,
  bulk_delete_contacts: out(
    { requested: num, deleted: num, skipped: num },
    'Counts from a bulk contact deletion',
  ),
  get_contact_timeline: out(
    { items: list(contactActivityItem), nextCursor: str, hasMore: bool },
    "A contact's unified activity timeline, cursor-paginated",
  ),
  get_contact_emails: out(
    { data: list(crmEmail), total: num },
    "A contact's synced emails, most recent first",
  ),
  get_deal_emails: out(
    { data: list(crmEmail), total: num },
    "A deal's synced emails, most recent first",
  ),
  get_email_body: out(
    { html: str, text: str, attachments: list(record) },
    'The full body of one synced email, fetched on demand',
  ),
  get_email_send_capability: out(
    {
      canSend: bool,
      provider: str.describe('google, microsoft or imap'),
    },
    "Whether the current user's connected mailbox could send right now",
  ),
  list_pipelines: listOf(pipeline, 'Sales pipelines and their stages'),
  create_pipeline: pipeline,
  update_pipeline: pipeline,
  delete_pipeline: ok,
  add_pipeline_stage: pipelineStage,
  update_pipeline_stage: pipelineStage,
  delete_pipeline_stage: ok,
  reorder_pipeline_stages: listOf(pipelineStage, 'The stages in their new order'),
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
  add_deal_contact: dealContact,
  update_deal_contact: dealContact,
  remove_deal_contact: ok,
  delete_deal: ok,
  mark_deal_won: deal,
  mark_deal_lost: deal,
  reopen_deal: deal,
  get_deal_activity: listOf(dealActivity, "A deal's activity log, most recent first"),
  get_deal_appointments: listOf(record, "A deal's appointments; shape unconfirmed"),
  get_deal_summary: out(
    {
      totalDeals: num,
      totalValue: num,
      weightedForecast: num,
      openDeals: num,
      wonDeals: num,
      lostDeals: num,
      currencies: list(record).describe('Deal counts by currency'),
      displayCurrency: str.describe('Majority currency, for formatting the aggregate totals'),
      byStage: list(record),
    },
    'Deal counts and value across the pipeline, grouped by stage',
  ),
  get_deal_limits: out(
    { count: num, limit: num.describe('-1 means unlimited on the current plan') },
    "The account's deal count against its plan limit",
  ),
  get_quiet_contacts: out(
    {
      totalOpenDealsScanned: num,
      quietDeals: list(quietDeal),
    },
    'Open deals gone quiet, ranked by value, computed client-side',
  ),
  find_duplicate_deals: listOf(record, 'Deals that look like duplicates, each with a match score'),
  get_deal_contact_suggestions: listOf(record, 'Contacts this deal is probably about'),
  merge_deals: out(
    {
      dealId: str.describe('The surviving deal'),
      mergedCount: any('Deals merged in'),
      moved: record.nullable().optional().describe('Counts of records moved onto the survivor, by type'),
    },
    'Result of merging duplicate deals into the survivor',
  ),
  bulk_import_deals: out(
    {
      contactsCreated: num,
      contactsUpdated: num,
      contactsSkipped: num,
      dealsCreated: num,
      dealsSkipped: num.describe('Not created because the plan deal limit was reached'),
      failed: num,
      issues: list(record),
    },
    'Result counts from the bulk deal import',
  ),
  list_companies: out(
    {
      result: list(company),
      companies: list(company),
      total: any('Total matches'),
      page: any('Current page'),
      limit: any('Page size'),
      totalPages: any('Total pages'),
    },
    'Paginated CRM companies',
  ),
  get_company: company,
  create_company: company,
  update_company: company,
  delete_company: ok,
  get_company_by_domain: company,
  get_company_contacts: listOf(contact, 'Contacts linked to the company'),
  get_company_deals: listOf(deal, 'Deals linked to the company'),
  get_company_summary: out(
    {
      totalCompanies: num,
      totalDealsValue: num,
      companiesWithDeals: num,
      byIndustry: list(record).describe('Company counts grouped by industry'),
      bySize: list(record).describe('Company counts grouped by size band'),
    },
    'Company counts and pipeline value, grouped by industry and size',
  ),
  get_custom_field_definitions: out(
    { fields: list(customFieldDefinition) },
    'Custom field definitions for the record type',
  ),
  update_custom_field_definitions: out(
    { fields: list(customFieldDefinition) },
    'Custom field definitions after the replace',
  ),
  get_lost_reasons: out(
    { reasons: list(record), required: bool },
    'Selectable lost-deal reasons and whether picking one is required',
  ),
  update_lost_reasons: out(
    { reasons: list(record), required: bool },
    'Selectable lost-deal reasons after the replace',
  ),
  get_company_meeting_history: out(
    {
      meetings: num,
      people: num,
      firstMeetingAt: str,
      lastMeetingAt: str,
    },
    'Meeting count and date range for a company',
  ),
  list_communications: listOf(communication, "Logged communications for the company, deal or contact"),
  create_communication: communication,
  update_communication: communication,
  delete_communication: ok,
  list_notes: listOf(note, 'Logged notes for the company, deal or contact'),
  create_note: note,
  update_note: note,
  delete_note: ok,
  list_attachments: listOf(attachment, 'Attachments on the company, deal or contact'),
  list_tasks: out(
    {
      tasks: list(task),
      total: any('Total matches'),
      page: any('Current page'),
      limit: any('Page size'),
      totalPages: any('Total pages'),
    },
    'Paginated CRM tasks',
  ),
  get_task: task,
  get_task_summary: out(
    {
      totalTasks: num,
      completedTasks: num,
      overdueTasks: num,
      dueTodayTasks: num,
      dueThisWeekTasks: num,
      byType: list(record),
      byPriority: list(record),
    },
    'Aggregate task counts, overall or for one assignee',
  ),
  list_overdue_tasks: listOf(task, 'Open tasks past their due date'),
  list_upcoming_tasks: listOf(task, 'Open tasks due soon'),
  list_company_tasks: listOf(task, "A company's tasks"),
  create_task: task,
  update_task: task,
  complete_task: task,
  uncomplete_task: task,
  delete_task: ok,
  log_personal_followup: out(
    {
      note: record.nullable().optional(),
      task: record.nullable().optional(),
      content: str.describe('The formatted note content actually logged'),
      followUpDueDate: str,
      taskCreated: bool.describe('false when the note was logged but the linked reminder task then failed'),
      taskError: str.describe('Present only when taskCreated is false'),
      suggestedTask: record
        .nullable()
        .optional()
        .describe('Present only when taskCreated is false — pass this to the task-creation tool to complete the reminder'),
    },
    'A logged personal follow-up conversation, plus its linked reminder task',
  ),
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
  ...DOCS_OUTPUTS,
  ...AVAILABILITY_OUTPUTS,
  ...SPACES_OUTPUTS,
  ...ENGAGEMENT_OUTPUTS,
  ...BOOKING_SETUP_OUTPUTS,
  ...INVOICING_OUTPUTS,
  ...PLAN_OUTPUTS,
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
