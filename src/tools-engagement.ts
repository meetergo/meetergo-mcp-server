import { z } from 'zod/v3'
import { any, bool, list, num, out, str } from './output-helpers.js'
import { definedOnly, iso, listLimit } from './tool-helpers.js'
import type { ToolDefinition } from './tools.js'

/**
 * Engagement: WhatsApp, e-signatures, provisional bookings, handoffs, attendee
 * follow-up and meeting recaps. Every path below is a /v4 route, so it is
 * requested without the prefix (the client base URL already ends in /v4).
 *
 * Several tools here reach a third party (a WhatsApp message, a signing
 * invitation, a decline mail, a public recap link, a transcript mail); those
 * are `openWorld` and say in the description that the user confirms first.
 */

/** A required-by-mode argument the zod shape cannot express on its own. */
function need<T>(value: T | undefined, name: string, when: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required for ${when}`)
  return value
}

const signerKey = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .describe('Stable key tying fields to this signer; required with more than one signer')

const signatureField = z.object({
  name: z.string().max(120),
  signerKey: signerKey.optional(),
  type: z.enum(['signature', 'initials', 'text', 'date', 'number', 'checkbox']).optional(),
  areas: z
    .array(
      z.object({
        x: z.number().min(0).max(1).describe('Left edge, fraction of page width'),
        y: z.number().min(0).max(1).describe('Top edge, fraction of page height, from the top'),
        w: z.number().min(0).max(1),
        h: z.number().min(0).max(1),
        page: z.number().min(1).describe('1-indexed'),
      }),
    )
    .min(1),
  required: z.boolean().optional(),
  defaultValue: z.string().max(2000).optional(),
})

const signer = z.object({
  key: signerKey.optional(),
  email: z.string().email().max(320).optional(),
  name: z.string().max(200).optional(),
  role: z.string().max(120).optional(),
  deliveryChannel: z
    .enum(['link', 'email', 'sms', 'whatsapp'])
    .optional()
    .describe('Defaults to link: nothing is sent, the signing link is returned'),
  phone: z.string().max(40).optional().describe('Required for sms or whatsapp delivery'),
})

const emailText = z.object({
  subject: z.string().max(300),
  bodyHtml: z.string().max(20000),
})

export const ENGAGEMENT_TOOLS: ToolDefinition[] = [
  // ---- WhatsApp -------------------------------------------------------------
  {
    name: 'get_whatsapp',
    title: 'Read WhatsApp data',
    description:
      'Read WhatsApp data, selected by `view`: senders (business numbers), templates (approved ones are needed outside the 24h window), conversations (newest first; filter by phone/status), conversation (one, needs conversationId; shows windowOpen), messages (of a conversation, newest first) or feed (messages after `since`, oldest first; pass nextSince back to advance). Needs the WhatsApp add-on (company.featureAccess.whatsappAddon); without it the API answers 403.',
    schema: {
      view: z.enum(['senders', 'templates', 'conversations', 'conversation', 'messages', 'feed']),
      conversationId: z.string().optional().describe('For view conversation or messages'),
      phoneNumberId: z.string().optional().describe('For view templates: business sender; omit for the default'),
      phone: z.string().optional().describe('For view conversations: exact contact number'),
      status: z.enum(['open', 'done', 'all']).optional().describe('For view conversations. Defaults to all.'),
      cursor: z.string().optional().describe('For conversations/messages: nextCursor of the previous page'),
      since: iso.optional().describe('For view feed (required): ISO 8601 timestamp, returns messages strictly after it'),
      direction: z.enum(['inbound', 'outbound', 'all']).optional().describe('For view feed. Defaults to inbound.'),
      limit: z.number().int().min(1).optional().describe('For conversations, messages and feed'),
    },
    readOnly: true,
    run: async (client, a) => {
      switch (a.view) {
        case 'senders':
          return client.request('GET', '/whatsapp/senders')
        case 'templates':
          return client.request('GET', '/whatsapp/templates', {
            query: { phoneNumberId: a.phoneNumberId },
          })
        case 'conversations':
          return client.request('GET', '/whatsapp/conversations', {
            query: { limit: a.limit, cursor: a.cursor, phone: a.phone, status: a.status },
          })
        case 'conversation':
          return client.request(
            'GET',
            `/whatsapp/conversations/${need(a.conversationId, 'conversationId', 'view conversation')}`,
          )
        case 'messages':
          return client.request(
            'GET',
            `/whatsapp/conversations/${need(a.conversationId, 'conversationId', 'view messages')}/messages`,
            { query: { limit: a.limit, cursor: a.cursor } },
          )
        default:
          return client.request('GET', '/whatsapp/messages', {
            query: {
              since: need(a.since, 'since', 'view feed'),
              limit: a.limit,
              direction: a.direction,
            },
          })
      }
    },
  },
  {
    name: 'send_whatsapp_message',
    title: 'Send a WhatsApp message',
    description:
      'Send a WhatsApp message to a phone number or BSUID; the conversation is created or reused. Reaches a third party, so confirm recipient and content with the user first. Free text and media only work while the 24h window is open (see windowOpen on the conversation); otherwise the API returns 403 and an approved template must be sent (list the templates first). Needs the WhatsApp add-on (company.featureAccess.whatsappAddon).',
    schema: {
      to: z.string().max(140).describe('Phone number (E.164, e.g. +491234567890) or WhatsApp BSUID'),
      type: z.enum(['text', 'template', 'media']),
      text: z.string().max(4096).optional().describe('Required for type text'),
      template: z
        .object({
          name: z.string().max(512).describe('Approved template name'),
          language: z.string().max(35).describe('Template locale, e.g. de or en_US'),
          params: z.array(z.string()).optional().describe('Values for {{1}}, {{2}}, ...; length = variableCount'),
          buttonUrlParams: z
            .record(z.string())
            .optional()
            .describe('Dynamic URL-button suffixes keyed by zero-based button index'),
        })
        .optional()
        .describe('Required for type template'),
      media: z
        .object({
          url: z.string().url().max(2048).describe('Public HTTPS URL reachable by WhatsApp'),
          mimeType: z.string().max(255).regex(/^[\w.+-]+\/[\w.+-]+$/),
          filename: z.string().max(255).optional(),
          caption: z.string().max(1024).optional(),
        })
        .optional()
        .describe('Required for type media'),
      phoneNumberId: z.string().optional().describe('Business sender, from the senders list; omit for the default'),
      contactName: z.string().max(255).optional().describe('Name for a newly created conversation'),
    },
    readOnly: false,
    openWorld: true,
    run: async (client, a) => {
      if (a.type === 'text') need(a.text, 'text', 'type text')
      if (a.type === 'template') need(a.template, 'template', 'type template')
      if (a.type === 'media') need(a.media, 'media', 'type media')
      return client.request('POST', '/whatsapp/messages', { body: definedOnly(a) })
    },
  },

  // ---- Signatures -----------------------------------------------------------
  {
    name: 'get_signatures',
    title: 'Read signature requests',
    description:
      'Read e-signature data, selected by `view`: usage (this month against the plan allowance; -1 = unlimited), list (newest first, 50 per page; pass the last id as `before`), get (status and signers of one request, needs id) or document (time-limited URL of the signed PDF, needs id; only once completed).',
    schema: {
      view: z.enum(['usage', 'list', 'get', 'document']),
      id: z.string().optional().describe('Signature request id, for view get or document'),
      before: z.string().optional().describe('For view list: id of the last request of the previous page'),
    },
    readOnly: true,
    run: async (client, a) => {
      switch (a.view) {
        case 'usage':
          return client.request('GET', '/signatures/usage')
        case 'list':
          return client.request('GET', '/signatures', { query: { before: a.before } })
        case 'get':
          return client.request('GET', `/signatures/${need(a.id, 'id', 'view get')}`)
        default:
          return client.request('GET', `/signatures/${need(a.id, 'id', 'view document')}/document`)
      }
    },
  },
  {
    name: 'manage_signature',
    title: 'Create, cancel or resend a signature request',
    description:
      'Act on a signature request via `action`. create: uploads a base64 PDF, places fields (normalized 0-1 coordinates, top-left origin) and returns one signing link per signer; with deliveryChannel email/sms/whatsapp the invitation is sent. cancel: kills a pending request and its links (completed ones cannot be cancelled). resend: retries the stored SMS/WhatsApp invitation of one signer. Signers are third parties, so confirm with the user first. Requires an API Platform subscription.',
    schema: {
      action: z.enum(['create', 'cancel', 'resend']),
      id: z.string().optional().describe('Request id, for cancel and resend'),
      signerId: z.string().optional().describe('Signer id from get_signatures get, for resend'),
      name: z.string().max(200).optional().describe('create: document name'),
      file: z.string().optional().describe('create: source PDF, base64 (max 20 MB). Exactly one of file and files.'),
      files: z
        .array(z.string())
        .min(1)
        .max(10)
        .optional()
        .describe('create: several base64 PDFs signed as one document, in order (max 20 MB, 200 pages)'),
      fields: z.array(signatureField).min(1).optional().describe('create: fields to place; each needs signerKey when there are several signers'),
      signers: z.array(signer).min(1).max(10).optional().describe('create: 1-10 signers'),
      signingOrder: z.enum(['parallel', 'sequential']).optional().describe('create: sequential follows signer array order. Defaults to parallel.'),
      expiresAt: iso.optional().describe('create: signing links stop working after this'),
      language: z
        .enum(['en', 'de', 'fr', 'es', 'no', 'nl', 'it', 'pl', 'se', 'tr', 'da', 'pt', 'ru', 'uk'])
        .optional()
        .describe('create: language for signing and notifications'),
      completedRedirectUrl: z.string().url().optional().describe('create: where the signer lands afterwards'),
      requireOtp: z.boolean().optional().describe('create: email OTP check; Suite plan or above, every signer needs an email'),
      sendSignedCopyToSigners: z.boolean().optional().describe('create: email the finished document to signers. Defaults to true.'),
      automaticReminders: z.boolean().optional().describe('create: reminder every 3 days, up to 3'),
      emailTexts: z
        .object({ invitation: emailText.optional(), signed_copy: emailText.optional() })
        .optional()
        .describe('create: custom email wording (simple HTML; {{documentName}}, {{signerName}} placeholders)'),
      whatsappPhoneNumberId: z.string().optional().describe('create: WhatsApp sender for whatsapp signers'),
      whatsappTemplateName: z.string().max(200).optional().describe('create: approved template for whatsapp signers'),
      whatsappTemplateLanguage: z.string().max(35).optional(),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: async (client, { action, id, signerId, ...create }) => {
      if (action === 'cancel') {
        return client.request('DELETE', `/signatures/${need(id, 'id', 'action cancel')}`)
      }
      if (action === 'resend') {
        return client.request(
          'POST',
          `/signatures/${need(id, 'id', 'action resend')}/signers/${need(signerId, 'signerId', 'action resend')}/send`,
        )
      }
      need(create.name, 'name', 'action create')
      need(create.fields, 'fields', 'action create')
      need(create.signers, 'signers', 'action create')
      if ((create.file === undefined) === (create.files === undefined)) {
        throw new Error('Send exactly one of file and files for action create')
      }
      return client.request('POST', '/signatures', { body: definedOnly(create) })
    },
  },

  // ---- Provisional bookings -------------------------------------------------
  {
    name: 'list_provisional_bookings',
    title: 'List provisional bookings',
    description:
      'List bookings that wait for confirmation: type requireHostConfirmation needs the host, doubleOptIn waits for the attendee. Non-admins see their own; all, userId and meetingTypeId are admin only.',
    schema: {
      page: z.number().int().min(1).optional().describe('Defaults to 1'),
      pageSize: listLimit.describe('Page size, 1-100. Defaults to 20.'),
      status: z.enum(['pending', 'confirmed', 'expired', 'declined_by_host']).optional(),
      type: z.enum(['doubleOptIn', 'requireHostConfirmation']).optional(),
      all: z.boolean().optional().describe('Whole company (admin only)'),
      userId: z.string().optional().describe('Admin only'),
      meetingTypeId: z.string().optional().describe('Admin only'),
      workspaceId: z.string().optional().describe('Only hosts of this workspace'),
    },
    readOnly: true,
    run: (client, { page, pageSize, ...filters }) =>
      client.request('GET', '/provisional-booking/paginated', {
        query: { page: page ?? 1, pageSize: pageSize ?? 20, ...filters },
      }),
  },
  {
    name: 'resolve_provisional_booking',
    title: 'Decline or delete a provisional booking',
    description:
      'decline: rejects a pending booking request and notifies the attendee, optionally with a reason. delete: soft-deletes it silently. Confirm with the user first; to accept a request use the host confirmation flow in meetergo.',
    schema: {
      id: z.string().describe('Provisional booking id from list_provisional_bookings'),
      action: z.enum(['decline', 'delete']),
      reason: z.string().optional().describe('For decline: reason shown to the attendee'),
    },
    readOnly: false,
    destructive: true,
    // decline sends the attendee a notification.
    openWorld: true,
    run: (client, { id, action, reason }) =>
      action === 'decline'
        ? client.request('POST', `/provisional-booking/${id}/decline`, {
            body: definedOnly({ reason }),
          })
        : client.request('DELETE', `/provisional-booking/${id}`),
  },

  // ---- Handoff ----------------------------------------------------------------
  {
    name: 'list_handoff_options',
    title: 'List handoff targets',
    description:
      'List the users an appointment (or a channel) can be handed off to, with a blocked reason where a user cannot take it. scope says whether the list is the appointment workspace or the whole company. Needs the Handoff plan feature (company.featureAccess.handoff); without it the API answers 403.',
    schema: {
      appointmentId: z.string().optional(),
      channelId: z.string().optional(),
      isOnline: z.boolean().optional().describe('Only users who are online'),
      showAll: z.boolean().optional().describe('Include all company users even for a workspace appointment'),
    },
    readOnly: true,
    run: (client, a) =>
      client.request('GET', '/handoff/available-handoffs', { query: definedOnly(a) }),
  },
  {
    name: 'handoff_appointments',
    title: 'Hand off appointments',
    description:
      'Change the host of appointments. Single: appointmentId plus exactly one of userId, queueId, queueGroupId. Bulk: fromUserIds + start + end (all their appointments in that period) plus targetUserId or targetUserIds (round-robin), optionally narrowed with appointmentIds; returns success and conflict ids. Hosts and attendees are affected, so confirm with the user first. Needs the Handoff plan feature (company.featureAccess.handoff); without it the API answers 403.',
    schema: {
      appointmentId: z.string().optional().describe('Single mode'),
      userId: z.string().optional().describe('Single mode: new host'),
      queueId: z.string().optional().describe('Single mode: hand to a queue'),
      queueGroupId: z.string().optional().describe('Single mode: hand to a queue group'),
      fromUserIds: z.array(z.string()).min(1).optional().describe('Bulk mode: hosts whose appointments move'),
      start: iso.optional().describe('Bulk mode: period start'),
      end: iso.optional().describe('Bulk mode: period end'),
      targetUserId: z.string().optional().describe('Bulk mode: new host'),
      targetUserIds: z.array(z.string()).min(1).optional().describe('Bulk mode: distribute across these users'),
      appointmentIds: z.array(z.string().uuid()).min(1).optional().describe('Bulk mode: only these appointments'),
      enableAvailabilityCheck: z.boolean().optional().describe('Bulk mode: check the target is free'),
      ignoreAvailability: z.boolean().optional().describe('Bulk mode: hand off even on conflicts'),
    },
    readOnly: false,
    destructive: true,
    // Hosts and attendees are notified of a host change.
    openWorld: true,
    run: async (client, a) => {
      if (a.appointmentId !== undefined) {
        const targets = [a.userId, a.queueId, a.queueGroupId].filter((v) => v !== undefined)
        if (targets.length !== 1) {
          throw new Error('Single handoff needs exactly one of userId, queueId, queueGroupId')
        }
        return client.request('POST', '/handoff/appointment', {
          body: definedOnly({
            appointmentId: a.appointmentId,
            userId: a.userId,
            queueId: a.queueId,
            queueGroupId: a.queueGroupId,
          }),
        })
      }
      need(a.fromUserIds, 'fromUserIds', 'bulk handoff (or pass appointmentId for a single one)')
      need(a.start, 'start', 'bulk handoff')
      need(a.end, 'end', 'bulk handoff')
      if (a.targetUserId === undefined && a.targetUserIds === undefined) {
        throw new Error('Bulk handoff needs targetUserId or targetUserIds')
      }
      return client.request('POST', '/handoff/bulk', {
        body: definedOnly({
          // The API names the source hosts `userId`, as an array.
          userId: a.fromUserIds,
          start: a.start,
          end: a.end,
          targetUserId: a.targetUserId,
          targetUserIds: a.targetUserIds,
          appointmentIds: a.appointmentIds,
          enableAvailabilityCheck: a.enableAvailabilityCheck,
          ignoreAvailability: a.ignoreAvailability,
        }),
      })
    },
  },

  // ---- Attendee follow-up -------------------------------------------------
  {
    name: 'update_attendee',
    title: 'Mark no-show or edit attendee fields',
    description:
      'action no_show: marks an attendee as no-show for reporting. action notes: patches the attendee record with string key/value pairs (for example company or phone), e.g. when a CRM sync failed; this is not the appointment note (use the appointment-notes tool). The attendee id is part of the appointment record.',
    schema: {
      attendeeId: z.string(),
      action: z.enum(['no_show', 'notes']),
      notes: z
        .record(z.string())
        .optional()
        .describe('For action notes: field name to string value, e.g. {"company":"Acme","phone":"+491234567890"}'),
    },
    readOnly: false,
    run: async (client, { attendeeId, action, notes }) =>
      action === 'no_show'
        ? client.request('POST', `/attendee/no-show/${attendeeId}`)
        : client.request('PATCH', `/attendee/${attendeeId}/notes`, {
            body: need(notes, 'notes', 'action notes'),
          }),
  },
  {
    name: 'draft_follow_up_email',
    title: 'Draft a meeting follow-up email',
    description:
      'Generates an editable follow-up subject and body from the appointment summary or transcript. Only drafts, sends nothing; send it by quick email after the user approved the text. Fails with 400 if the appointment has no notes.',
    schema: {
      appointmentId: z.string(),
      language: z.string().max(8).optional().describe('Two-letter code. Defaults to the company language.'),
    },
    readOnly: false,
    run: (client, { appointmentId, language }) =>
      client.request('POST', `/appointment/${appointmentId}/follow-up-draft`, {
        body: definedOnly({ language }),
      }),
  },
  {
    name: 'set_recap_sharing',
    title: 'Share or unshare a meeting recap',
    description:
      'shared true: publishes the meeting recap behind a public link. shared false: revokes that link. Anyone with the link can read a published recap, so confirm with the user first.',
    schema: {
      appointmentId: z.string(),
      shared: z.boolean(),
    },
    readOnly: false,
    openWorld: true,
    run: (client, { appointmentId, shared }) =>
      client.request('POST', `/appointment/${appointmentId}/recap/${shared ? 'share' : 'unshare'}`),
  },
  {
    name: 'email_meeting_transcript',
    title: 'Email meeting notes',
    description:
      'Sends a meeting summary and/or transcript (markdown) as an email to one address. The caller supplies the content; nothing is read from an appointment. Reaches a third party, so confirm recipient and content with the user first.',
    schema: {
      to: z.string().email().describe('Recipient address'),
      meetingTitle: z.string().max(300).optional().describe('Used in the subject and as heading'),
      summary: z.string().max(100000).optional().describe('Markdown'),
      transcription: z.string().max(500000).optional().describe('Markdown'),
      summaryLabel: z.string().max(120).optional(),
      transcriptLabel: z.string().max(120).optional(),
    },
    readOnly: false,
    openWorld: true,
    run: (client, a) =>
      client.request('POST', '/meeting-transcript/email', { body: definedOnly(a) }),
  },
]

const whatsappMessage = out(
  {
    id: str,
    conversationId: str,
    waMessageId: str,
    direction: str.describe('inbound or outbound'),
    type: str.describe('text, image, document, template, ...'),
    status: str.describe('pending, sent, delivered, read or failed'),
    text: str,
    mediaUrl: str,
    templateName: str,
    errorMessage: str.describe('Set when status is failed'),
    createdAt: str,
  },
  'A WhatsApp message',
)

const signatureRequest = out(
  {
    id: str,
    name: str,
    status: str.describe('pending, in_progress, finalizing, finalization_failed, completed or cancelled'),
    signingOrder: str,
    signers: any('Signers with id, status, signingUrl and invitationDelivery'),
    signedDocumentUrl: str.describe('Time-limited; present once completed'),
    completedAt: str,
    expiresAt: str,
    createdAt: str,
  },
  'A signature request',
)

export const ENGAGEMENT_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  get_whatsapp: out(
    {
      data: any('Senders, templates, conversations or messages, depending on the view'),
      nextCursor: str.describe('Pass as cursor for the next page'),
      nextSince: str.describe('Feed only: pass back as since'),
      id: str,
      phone: str,
      windowOpen: bool.describe('Conversation view: whether free-text sending is allowed'),
      windowExpiresAt: str,
      status: str,
    },
    'WhatsApp data; shape per API for the chosen view',
  ),
  send_whatsapp_message: whatsappMessage,
  get_signatures: out(
    {
      items: list(signatureRequest).describe('View list: the requests'),
      id: str,
      name: str,
      status: str,
      signers: any('Signers with id, status, signingUrl and invitationDelivery'),
      signedDocumentUrl: str,
      url: str.describe('View document: time-limited URL of the signed PDF'),
      used: any('View usage: signatures used this month'),
      limit: num.describe('View usage: allowance, -1 = unlimited'),
    },
    'Signature usage, a list of requests, one request or the signed-document URL; shape per API for the chosen view',
  ),
  manage_signature: signatureRequest,
  list_provisional_bookings: out(
    {
      provisionalBookings: list(
        out(
          {
            id: str,
            type: str.describe('doubleOptIn or requireHostConfirmation'),
            status: str,
            createdAt: str,
            dto: any('The booking request'),
            hosts: any('Hosts of the booking'),
            meetingTypeId: str,
          },
          'A provisional booking',
        ),
      ),
      total: num,
    },
    'Provisional bookings, one page',
  ),
  resolve_provisional_booking: out({}, 'Empty success'),
  list_handoff_options: out(
    {
      users: any('Users with id, firstname, lastname and an optional blocked reason'),
      scope: str.describe('workspace or company'),
    },
    'Possible handoff targets',
  ),
  handoff_appointments: out(
    {
      success: any('Bulk only: appointment ids handed off'),
      conflicts: any('Bulk only: appointment ids that could not be handed off'),
    },
    'Handoff result; a single handoff returns an empty success',
  ),
  update_attendee: out({}, 'Empty success'),
  draft_follow_up_email: out(
    {
      subject: str,
      body: str,
    },
    'The generated draft; field names per API',
  ),
  set_recap_sharing: out(
    {
      url: str.describe('Public recap link, when shared'),
    },
    'Recap sharing result; shape per API',
  ),
  email_meeting_transcript: out({}, 'Empty success'),
}
