import type { MeetergoClient, RequestOptions } from '../client.js'
import { TOOLS, sanitizeMiraSettingsForPatch } from '../tools.js'

/**
 * These assertions are about the agent contract, not implementation detail.
 * A tool renamed or an annotation flipped silently changes what a host will
 * auto-run without asking a human — that is worth a failing test.
 */
describe('meetergo MCP tool surface', () => {
  it('covers the API surface an agent needs, with no duplicate names', () => {
    expect(TOOLS).toHaveLength(49)
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length)
  })

  it('leads with the scheduling loop', () => {
    // Tool order is a weak prior for selection. The common path should be the
    // first thing a model reads, not buried under CRM and webhook config.
    expect(TOOLS.slice(0, 8).map((t) => t.name)).toEqual([
      'get_me',
      'list_meeting_types',
      'get_availability',
      'book_appointment',
      'reschedule_appointment',
      'cancel_appointment',
      'list_appointments',
      'get_todays_appointments',
    ])
  })

  it('covers the full loop an agent needs to run a calendar', () => {
    const names = TOOLS.map((t) => t.name)
    for (const required of [
      'get_me', // who am I
      'list_meeting_types', // discover
      'get_availability', // when
      'book_appointment', // schedule
      'reschedule_appointment', // change
      'cancel_appointment', // undo
      'list_appointments', // review
      'get_contact', // who is this
    ]) {
      expect(names).toContain(required)
    }
  })

  it('marks exactly the mutating tools as writes', () => {
    const writes = TOOLS.filter((t) => !t.readOnly)
      .map((t) => t.name)
      .sort()
    // Hosts gate confirmation on readOnlyHint. Mislabelling a write as a read
    // means an agent books, cancels or deletes without anyone being asked.
    expect(writes).toEqual([
      'add_guest',
      'book_appointment',
      'bulk_create_contacts',
      'cancel_appointment',
      'crawl_company_website',
      'create_contact',
      'create_data_field',
      'create_meeting_type',
      'create_one_time_booking_link',
      'create_routing_form',
      'create_webhook',
      'delete_contact',
      'delete_knowledge_document',
      'delete_meeting_type',
      'delete_routing_form',
      'delete_webhook',
      'reschedule_appointment',
      'restore_mira_settings',
      'send_quick_email',
      'send_routing_form',
      'update_appointment_notes',
      'update_contact',
      'update_meeting_transcription',
      'update_meeting_type',
      'update_mira_settings',
      'update_personal_page',
      'update_routing_form',
      'update_webhook',
    ])
  })

  it('marks every irreversible tool destructive', () => {
    const destructive = TOOLS.filter((t) => t.destructive)
      .map((t) => t.name)
      .sort()
    // Everything that removes something a human would miss. A delete that is
    // not flagged is a delete a host will let an agent do unattended.
    expect(destructive).toEqual([
      'cancel_appointment',
      'delete_contact',
      'delete_knowledge_document',
      'delete_meeting_type',
      'delete_routing_form',
      'delete_webhook',
      // Not deletes, but both overwrite the live assistant configuration a
      // company's website widget is answering from.
      'restore_mira_settings',
      'update_mira_settings',
      // Not a delete, but its qualifier sync removes whatever you leave out.
      'update_routing_form',
    ])
  })

  it('never marks a read as destructive', () => {
    for (const tool of TOOLS.filter((t) => t.readOnly)) {
      expect(tool.destructive).toBeFalsy()
    }
  })

  it('gives every tool a description an agent can choose on', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.title).toBeTruthy()
    }
  })

  it('requires an identifier on every tool that changes an existing record', () => {
    // Creates take no id by definition; everything else must name its target,
    // or an agent can fire it with no arguments and hit something arbitrary.
    const isCreate = (n: string) =>
      n.startsWith('create_') || n === 'bulk_create_contacts'
    const targets = [
      'appointmentId',
      'meetingTypeId',
      'contactId',
      'formId',
      'webhookId',
      'attendeeId',
      'documentId',
    ]
    // Company-scoped singletons: there is exactly one target (the caller's own
    // page / the company's Mira config / its knowledge base), so no id exists.
    const exempt = new Set([
      'update_personal_page',
      'update_mira_settings',
      'restore_mira_settings',
      'crawl_company_website',
    ])

    for (const tool of TOOLS.filter(
      (t) => !t.readOnly && !isCreate(t.name) && !exempt.has(t.name),
    )) {
      const keys = Object.keys(tool.schema)
      expect(keys.length, `${tool.name} takes no arguments`).toBeGreaterThan(0)
      expect(
        keys.some((k) => targets.includes(k)),
        `${tool.name} names no target`,
      ).toBe(true)
    }
  })
})

interface RecordedCall {
  method: string
  path: string
  options: RequestOptions
}

/**
 * Records what a tool would put on the wire. 0.1.x shipped five tools that
 * could never succeed — wrong paths, wrong query keys, a flat body where the
 * API wants a nested one — because every test asserted on the tool *list* and
 * none asserted on the *request*. These do.
 *
 * Each expectation below is pinned to a route or DTO in apps/api; when one
 * changes, this is where it should fail.
 */
function record(
  responses: Record<string, unknown> = {},
): { client: MeetergoClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    nextUrl: 'https://next.test',
    request: (method: string, path: string, options: RequestOptions = {}) => {
      calls.push({ method, path, options })
      return Promise.resolve(responses[path] ?? {})
    },
  } as unknown as MeetergoClient
  return { client, calls }
}

/** A single-host meeting type, so scope resolution has something to find. */
const SOLO_MEETING_TYPE = { '/meeting-type/mt-1': { id: 'mt-1', userId: 'u-1' } }

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  responses: Record<string, unknown> = SOLO_MEETING_TYPE,
): Promise<RecordedCall> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  const { client, calls } = record(responses)
  await tool.run(client, args)
  // The call under test is the last one; scope lookups come first.
  return calls[calls.length - 1]
}

describe('wire format', () => {
  it('asks for availability with start/end, not from/to', async () => {
    // NewGetAvailabilityDto requires `start` and `end`; `from`/`to` is a 400.
    const call = await callTool('get_availability', {
      meetingTypeId: 'mt-1',
      start: '2026-08-04T00:00:00Z',
      end: '2026-08-05T00:00:00Z',
    })
    expect(call).toMatchObject({ method: 'GET', path: '/booking-availability' })
    expect(call.options.query).toMatchObject({
      meetingTypeId: 'mt-1',
      start: '2026-08-04T00:00:00Z',
      end: '2026-08-05T00:00:00Z',
    })
    expect(call.options.query).not.toHaveProperty('from')
    expect(call.options.query).not.toHaveProperty('to')
  })

  it('resolves the host scope availability requires', async () => {
    // The API rejects with 400 "Expected hostIds or queueId" before it even
    // loads the meeting type, so a meetingTypeId alone can never work. The
    // model only has a meetingTypeId, so the tool resolves the rest.
    const { client, calls } = record(SOLO_MEETING_TYPE)
    const tool = TOOLS.find((t) => t.name === 'get_availability')!
    await tool.run(client, {
      meetingTypeId: 'mt-1',
      start: '2026-08-04T00:00:00Z',
      end: '2026-08-05T00:00:00Z',
    })
    expect(calls.map((c) => c.path)).toEqual([
      '/meeting-type/mt-1',
      '/booking-availability',
    ])
    expect(calls[1].options.query).toMatchObject({ hostIds: ['u-1'] })
  })

  it('scopes a queue meeting type by queueId instead of a host', async () => {
    const call = await callTool(
      'get_availability',
      {
        meetingTypeId: 'mt-2',
        start: '2026-08-04T00:00:00Z',
        end: '2026-08-05T00:00:00Z',
      },
      { '/meeting-type/mt-2': { id: 'mt-2', queueId: 'q-1' } },
    )
    expect(call.options.query).toMatchObject({ queueId: 'q-1' })
    expect(call.options.query).not.toHaveProperty('hostIds')
  })

  it('skips the lookup when the caller pins hosts explicitly', async () => {
    const { client, calls } = record()
    const tool = TOOLS.find((t) => t.name === 'get_availability')!
    await tool.run(client, {
      meetingTypeId: 'mt-1',
      start: '2026-08-04T00:00:00Z',
      end: '2026-08-05T00:00:00Z',
      hostIds: ['u-9'],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].options.query).toMatchObject({ hostIds: ['u-9'] })
  })

  it('explains a meeting type with no host rather than sending a doomed request', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_availability')!
    const { client } = record({ '/meeting-type/mt-3': { id: 'mt-3' } })
    await expect(
      tool.run(client, {
        meetingTypeId: 'mt-3',
        start: '2026-08-04T00:00:00Z',
        end: '2026-08-05T00:00:00Z',
      }),
    ).rejects.toThrow(/no host or queue configured/)
  })

  it('nests the attendee and fills the fields BookingDto requires', async () => {
    // `attendee` is @ValidateNested and not optional; `receiveReminders` is a
    // required boolean and `notes` a required record. A flat body is a 400.
    const call = await callTool('book_appointment', {
      meetingTypeId: 'mt-1',
      start: '2026-08-04T09:00:00Z',
      email: 'a@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
    expect(call).toMatchObject({ method: 'POST', path: '/booking' })
    expect(call.options.body).toEqual({
      meetingTypeId: 'mt-1',
      start: '2026-08-04T09:00:00Z',
      hostIds: ['u-1'],
      queueId: undefined,
      attendee: {
        email: 'a@example.com',
        firstname: 'Ada',
        lastname: 'Lovelace',
        fullname: undefined,
        phone: undefined,
        timezone: undefined,
        receiveReminders: true,
        dataPolicyAccepted: true,
        notes: {},
        bringalongEmails: undefined,
      },
    })
  })

  it('lets an explicit receiveReminders:false through', async () => {
    // `?? true` must not swallow a deliberate opt-out.
    const call = await callTool('book_appointment', {
      meetingTypeId: 'mt-1',
      start: '2026-08-04T09:00:00Z',
      email: 'a@example.com',
      fullName: 'Ada Lovelace',
      receiveReminders: false,
    })
    expect(call.options.body).toMatchObject({
      attendee: { receiveReminders: false },
    })
  })

  it('lists appointments off /paginated with the required page fields', async () => {
    // `GET /v4/appointment` is not a route, and GetPaginatedAppointmentsDto
    // requires both `page` (0-indexed) and `pageSize`.
    const call = await callTool('list_appointments')
    expect(call).toMatchObject({
      method: 'GET',
      path: '/appointment/paginated',
    })
    expect(call.options.query).toMatchObject({ page: 0, pageSize: 20 })
  })

  it('keeps page 0 rather than defaulting it away', async () => {
    const call = await callTool('list_appointments', { page: 0, pageSize: 50 })
    expect(call.options.query).toMatchObject({ page: 0, pageSize: 50 })
  })

  it('adds guests one at a time on /guest with an attendeeId', async () => {
    // The route is PATCH /:id/guest — not /guest-emails — and AddGuestEmailsDto
    // is { attendeeId, email }, singular.
    const call = await callTool('add_guest', {
      appointmentId: 'ap-1',
      attendeeId: 'at-1',
      email: 'guest@example.com',
    })
    expect(call).toMatchObject({
      method: 'PATCH',
      path: '/appointment/ap-1/guest',
      options: { body: { attendeeId: 'at-1', email: 'guest@example.com' } },
    })
  })

  it('reads calendar connections from the nested collection path', async () => {
    // The controller is @Controller('v4/calendar-connections') with @Get('connections').
    const call = await callTool('list_calendar_connections')
    expect(call.path).toBe('/calendar-connections/connections')
  })

  it('routes CRM tools to the host root, not /v4', async () => {
    // The CRM controller predates the v4 split and is mounted at the root.
    for (const [name, args] of [
      ['search_contacts', {}],
      ['create_contact', { email: 'a@example.com' }],
      ['get_contact', { contactId: 'c-1' }],
      ['update_contact', { contactId: 'c-1', notes: 'hi' }],
    ] as const) {
      const call = await callTool(name, args)
      expect(call.options.root, `${name} must target the host root`).toBe(true)
    }
  })

  it('keeps scheduling tools on the versioned base', async () => {
    for (const name of [
      'get_me',
      'list_meeting_types',
      'get_todays_appointments',
      'list_calendar_connections',
    ]) {
      const call = await callTool(name)
      expect(call.options.root, `${name} must stay under /v4`).toBeFalsy()
    }
  })

  it('carries a chosen duration into the booking', async () => {
    // get_availability can be asked for a non-default duration. Dropping it
    // here books the default length against a slot picked for another.
    const call = await callTool('book_appointment', {
      meetingTypeId: 'mt-1',
      start: '2026-08-04T09:00:00Z',
      email: 'a@example.com',
      fullName: 'Ada Lovelace',
      duration: 45,
    })
    expect(call.options.body).toMatchObject({ duration: 45 })
  })

  it('refuses a booking with no attendee name', async () => {
    // The API accepts this and writes an empty name into the invitation.
    const tool = TOOLS.find((t) => t.name === 'book_appointment')!
    const { client, calls } = record(SOLO_MEETING_TYPE)
    await expect(
      tool.run(client, {
        meetingTypeId: 'mt-1',
        start: '2026-08-04T09:00:00Z',
        email: 'a@example.com',
      }),
    ).rejects.toThrow(/fullName, or firstName and lastName/)
    // and must not have spent a request finding that out
    expect(calls).toHaveLength(0)
  })

  it('refuses a contact with neither email nor phone', async () => {
    const tool = TOOLS.find((t) => t.name === 'create_contact')!
    const { client, calls } = record()
    await expect(tool.run(client, { firstName: 'Ada' })).rejects.toThrow(
      /email or phoneNumber/,
    )
    expect(calls).toHaveLength(0)
  })

  it('routes webhooks to the host root, like the CRM', async () => {
    // /webhooks lives on the user module at the root, not under /v4.
    for (const [name, args] of [
      ['list_webhooks', {}],
      ['create_webhook', { endpoint: 'https://x.test', eventTypes: ['booking_created'] }],
      ['update_webhook', { webhookId: 'w-1', description: 'x' }],
      ['delete_webhook', { webhookId: 'w-1' }],
      ['bulk_create_contacts', { contacts: [{ email: 'a@example.com' }] }],
      ['delete_contact', { contactId: 'c-1' }],
    ] as const) {
      const call = await callTool(name, args)
      expect(call.options.root, `${name} must target the host root`).toBe(true)
    }
  })

  it('nests meetingInfo and sends nothing the API would strip', async () => {
    // Both meeting-type routes validate with whitelist: true, so any property
    // without a class-validator decorator is silently discarded. Sending one
    // would make the tool claim a setting it did not apply.
    const call = await callTool('create_meeting_type', {
      name: 'Discovery call',
      description: 'A first chat',
      duration: 30,
      channel: 'zoom',
    })
    expect(call).toMatchObject({ method: 'POST', path: '/meeting-type' })
    const body = call.options.body as { meetingInfo: Record<string, unknown> }
    expect(body.meetingInfo).toEqual({
      name: 'Discovery call',
      description: 'A first chat',
      duration: 30,
      channel: 'zoom',
    })
  })

  it('does not offer meeting-type fields the API discards', async () => {
    // Each of these is undecorated on the create DTO, so the request succeeds
    // and the value vanishes. Better to not accept it at all.
    const create = TOOLS.find((t) => t.name === 'create_meeting_type')!
    for (const stripped of [
      'slug',
      'userId',
      'groupBooking',
      'customChannelLink',
      'confirmationButton',
      'advanced',
    ]) {
      expect(Object.keys(create.schema)).not.toContain(stripped)
    }
    // slug IS validated on the update DTO, so it belongs there.
    const update = TOOLS.find((t) => t.name === 'update_meeting_type')!
    expect(Object.keys(update.schema)).toContain('slug')
  })

  it('never sends create-time defaults on an update', async () => {
    // UpdateMeetingInfoDto is fully partial, so the create defaults would blank
    // a custom channel on any unrelated edit.
    const call = await callTool('update_meeting_type', {
      meetingTypeId: 'mt-1',
      duration: 45,
    })
    expect(call).toMatchObject({ method: 'PATCH', path: '/meeting-type/mt-1' })
    const body = call.options.body as { meetingInfo: Record<string, unknown> }
    expect(body.meetingInfo).toEqual({ duration: 45 })
    for (const blanked of [
      'customChannelName',
      'customChannelLink',
      'connectChannelName',
      'confirmationButton',
    ]) {
      expect(body.meetingInfo).not.toHaveProperty(blanked)
    }
  })

  it('omits meetingInfo entirely when only the slug changes', async () => {
    const call = await callTool('update_meeting_type', {
      meetingTypeId: 'mt-1',
      slug: 'new-slug',
    })
    expect(call.options.body).not.toHaveProperty('meetingInfo')
    expect(call.options.body).toMatchObject({ slug: 'new-slug' })
  })

  it('sends transcription and quick mail to their own routes', async () => {
    const transcript = await callTool('update_meeting_transcription', {
      appointmentId: 'ap-1',
      summary: '# Notes',
    })
    expect(transcript).toMatchObject({
      method: 'PATCH',
      path: '/appointment/ap-1/transcription',
      options: { body: { summary: '# Notes' } },
    })

    const mail = await callTool('send_quick_email', {
      attendeeId: 'at-1',
      title: 'Prep',
      content: 'See you then',
    })
    expect(mail).toMatchObject({ method: 'POST', path: '/attendee/quick-mail' })
  })

  it('refuses a contact lookup with no identifier', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_contact')!
    const { client } = record()
    await expect(tool.run(client, {})).rejects.toThrow(/contactId or attendeeId/)
  })
})

describe('Mira & knowledge wire format', () => {
  // All of these routes predate the v4 split and are mounted at the host
  // root — a call without `root: true` lands on /v4/... and 404s.
  const SETTINGS_SNAPSHOT = {
    enabled: true,
    customInstructions: '',
    dataAccess: { meetingTypes: true },
    webChat: { enabled: false, assistantName: 'Mira', publicKey: 'mira_pub_abc' },
    assistantProfiles: [],
    channels: {
      webChat: [{ id: 'default-web', publicKey: 'mira_pub_abc' }],
      whatsapp: { enabled: false },
      phone: { enabled: false },
    },
  }

  it('reads mira settings from the host root', async () => {
    const call = await callTool('get_mira_settings')
    expect(call).toMatchObject({ method: 'GET', path: '/company/mira-settings' })
    expect(call.options.root).toBe(true)
  })

  it('returns the prior settings as a rollback snapshot', async () => {
    const responses = { '/company/mira-settings': SETTINGS_SNAPSHOT }
    const { client, calls } = record(responses)
    const tool = TOOLS.find((t) => t.name === 'update_mira_settings')!
    const result = (await tool.run(client, { enabled: true })) as {
      previous: unknown
    }
    // GET before PATCH: the snapshot must show the state the write replaced.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH'])
    expect(result.previous).toEqual(SETTINGS_SNAPSHOT)
  })

  it('strips the minted publicKey before patching webChat', async () => {
    const call = await callTool('update_mira_settings', {
      webChat: { enabled: false, assistantName: 'Mira', publicKey: 'mira_pub_x' },
    })
    // UpdateMiraSettingsDto runs forbidNonWhitelisted and has no publicKey
    // field — replaying a GET snapshot without stripping it is a 400.
    expect(call.method).toBe('PATCH')
    expect(call.options.body).toMatchObject({
      webChat: { enabled: false, assistantName: 'Mira' },
    })
    expect(
      (call.options.body as { webChat: Record<string, unknown> }).webChat,
    ).not.toHaveProperty('publicKey')
  })

  it('fills the mechanical assistant-profile fields the DTO requires', async () => {
    const call = await callTool('update_mira_settings', {
      assistantProfiles: [
        {
          id: 'p-1',
          name: 'Mira',
          welcomeMessage: 'Hallo!',
          purpose: 'sales',
          tone: 'professional',
          instructions: 'Qualify, then book.',
          capabilities: ['knowledge', 'booking'],
          boundaries: ['confidence'],
        },
      ],
    })
    const body = call.options.body as {
      assistantProfiles: Record<string, unknown>[]
    }
    // MiraAssistantProfileDto requires every field; these are the mechanical
    // ones the model should not have to invent.
    expect(body.assistantProfiles[0]).toMatchObject({
      id: 'p-1',
      logoUrl: null,
      avoidInstructions: '',
      outOfHoursMessage: '',
      knowledgeSourceIds: [],
      bookingMeetingTypeId: null,
      routingFormId: null,
      openingHoursAvailabilityId: null,
    })
  })

  it('sanitizes a snapshot before restoring it', async () => {
    const call = await callTool('restore_mira_settings', {
      settings: SETTINGS_SNAPSHOT,
    })
    expect(call).toMatchObject({ method: 'PATCH', path: '/company/mira-settings' })
    const body = call.options.body as Record<string, any>
    expect(body.webChat).not.toHaveProperty('publicKey')
    // The controller regenerates channels.webChat from webChat; replaying a
    // stale mirror is the one path that could corrupt a rollback.
    expect(body.channels).not.toHaveProperty('webChat')
    expect(body.channels).toHaveProperty('whatsapp')
    expect(body).toMatchObject({ enabled: true })
  })

  it('drops channels entirely when only the mirror was present', () => {
    const sanitized = sanitizeMiraSettingsForPatch({
      enabled: false,
      channels: { webChat: [{ id: 'default-web' }] },
    })
    expect(sanitized).toEqual({ enabled: false })
  })

  it('builds the embed snippet from the configured next host', async () => {
    const { client } = record({ '/company/mira-settings': SETTINGS_SNAPSHOT })
    const tool = TOOLS.find((t) => t.name === 'get_mira_widget_embed')!
    const result = (await tool.run(client, {})) as Record<string, string>
    // Must match the loader contract in apps/next/public/mira-widget.js and
    // the dashboard snippet builder (web-chat-snippet.ts).
    expect(result.loaderUrl).toBe('https://next.test/mira-widget.js')
    expect(result.snippet).toContain('data-mira-key="mira_pub_abc"')
    expect(result.previewUrl).toBe(
      'https://next.test/mira-widget?key=mira_pub_abc&preview=1',
    )
  })

  it('explains how to mint a key instead of returning a broken snippet', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_mira_widget_embed')!
    const { client } = record({ '/company/mira-settings': { webChat: {} } })
    await expect(tool.run(client, {})).rejects.toThrow(/update_mira_settings/)
  })

  it('starts a crawl with the fields the endpoint accepts', async () => {
    const call = await callTool('crawl_company_website', {
      url: 'http://localhost:8330',
      maxPages: 30,
      language: 'de',
    })
    expect(call).toMatchObject({ method: 'POST', path: '/knowledge/crawl' })
    expect(call.options.root).toBe(true)
    expect(call.options.body).toEqual({
      url: 'http://localhost:8330',
      maxPages: 30,
      language: 'de',
    })
  })

  it('reads crawl status and documents from the root-mounted routes', async () => {
    const status = await callTool('get_crawl_status')
    expect(status).toMatchObject({ method: 'GET', path: '/knowledge/crawl/status' })
    expect(status.options.root).toBe(true)

    const docs = await callTool('list_knowledge_documents')
    expect(docs).toMatchObject({ method: 'GET', path: '/knowledge/documents' })
    expect(docs.options.root).toBe(true)
  })

  it('deletes a knowledge document by id', async () => {
    const call = await callTool('delete_knowledge_document', {
      documentId: 'doc-1',
    })
    expect(call).toMatchObject({
      method: 'DELETE',
      path: '/knowledge/documents/doc-1',
    })
    expect(call.options.root).toBe(true)
  })

  it('searches knowledge with query and clamped k', async () => {
    const call = await callTool('search_company_knowledge', {
      query: 'PKV Wechsel',
      k: 5,
    })
    expect(call).toMatchObject({ method: 'POST', path: '/knowledge/search' })
    expect(call.options.body).toEqual({ query: 'PKV Wechsel', k: 5 })
    expect(call.options.root).toBe(true)
  })
})

describe('release hygiene', () => {
  it('reports the version the package claims', async () => {
    // The server hardcodes VERSION and the manifest carries its own. They are
    // the same number in two files, which is a drift waiting to happen — the
    // mirror shipped 0.1.1 while the handshake still announced 0.1.0. An MCP
    // client showing the wrong server version makes every bug report wrong.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version: string }
    const source = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain(`const VERSION = '${pkg.version}'`)
  })
})
