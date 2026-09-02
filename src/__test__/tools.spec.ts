import type { MeetergoClient, RequestOptions } from '../client.js'
import { TOOLS, sanitizeMiraSettingsForPatch } from '../tools.js'

/**
 * These assertions are about the agent contract, not implementation detail.
 * A tool renamed or an annotation flipped silently changes what a host will
 * auto-run without asking a human — that is worth a failing test.
 */
describe('meetergo MCP tool surface', () => {
  it('covers the API surface an agent needs, with no duplicate names', () => {
    expect(TOOLS).toHaveLength(76)
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
      'answer_visitor_question',
      'book_appointment',
      'bulk_create_contacts',
      'cancel_appointment',
      'crawl_company_website',
      'create_company',
      'create_contact',
      'create_data_field',
      'create_deal',
      'create_meeting_type',
      'create_one_time_booking_link',
      'create_qualification_form',
      'create_routing_form',
      'create_webhook',
      'delete_company',
      'delete_contact',
      'delete_deal',
      'delete_knowledge_document',
      'delete_meeting_type',
      'delete_routing_form',
      'delete_webhook',
      'import_booking_page',
      'mark_deal_lost',
      'mark_deal_won',
      'reopen_deal',
      'reschedule_appointment',
      'restore_mira_settings',
      // Not a data mutation an operator would name, but it persists the
      // checklist's test-drive verdict and spends real model budget — a host
      // that confirms expensive calls with the human must get the chance.
      'run_test_drive',
      'send_quick_email',
      'send_routing_form',
      'update_appointment_notes',
      'update_company',
      'update_contact',
      'update_deal',
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
      'add_guest',
      'answer_visitor_question',
      'book_appointment',
      'cancel_appointment',
      'delete_company',
      'delete_contact',
      'delete_deal',
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

  it('keeps directory descriptions self-contained', () => {
    const toolNames = new Set(TOOLS.map((tool) => tool.name))

    for (const tool of TOOLS) {
      const referencedTools =
        tool.description
          .match(/[a-z]+(?:_[a-z]+)+/g)
          ?.filter((name) => toolNames.has(name)) ?? []
      expect(referencedTools, tool.name).toEqual([])
    }
  })

  it('keeps the submitted annotations identical to the runtime tools', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const submission = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../chatgpt-app-submission.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as {
      tools: Record<
        string,
        {
          annotations: {
            readOnlyHint: boolean
            openWorldHint: boolean
            destructiveHint: boolean
          }
          justifications: Record<string, string>
        }
      >
      test_cases: Array<{
        description: string
        user_prompt: string
        tools_triggered: string | null
        expected_output: string
      }>
      negative_test_cases: Array<{
        description: string
        user_prompt: string
        tools_triggered: string | null
        expected_output: string
      }>
    }

    expect(Object.keys(submission.tools).sort()).toEqual(
      TOOLS.map((tool) => tool.name).sort(),
    )
    for (const tool of TOOLS) {
      const submitted = submission.tools[tool.name]
      expect(submitted.annotations, tool.name).toEqual({
        readOnlyHint: tool.readOnly,
        openWorldHint: tool.openWorld ?? false,
        destructiveHint: tool.destructive ?? false,
      })
      expect(
        Object.values(submitted.justifications).every(
          (justification) => justification.trim().length > 0,
        ),
        `${tool.name} justifications`,
      ).toBe(true)
    }

    expect(submission.test_cases).toHaveLength(5)
    expect(submission.negative_test_cases).toHaveLength(3)
    const toolNames = new Set(TOOLS.map((tool) => tool.name))
    for (const testCase of [
      ...submission.test_cases,
      ...submission.negative_test_cases,
    ]) {
      expect(testCase.description.trim(), 'test description').toBeTruthy()
      expect(testCase.user_prompt.trim(), 'test prompt').toBeTruthy()
      expect(testCase.expected_output.trim(), 'expected output').toBeTruthy()
      for (const toolName of testCase.tools_triggered?.split(/,\s*/) ?? []) {
        expect(toolNames.has(toolName), `unknown review tool ${toolName}`).toBe(
          true,
        )
      }
    }
  })

  it('requires an identifier on every tool that changes an existing record', () => {
    // Creates take no id by definition; everything else must name its target,
    // or an agent can fire it with no arguments and hit something arbitrary.
    const isCreate = (n: string) =>
      n.startsWith('create_') ||
      n === 'bulk_create_contacts' ||
      // Additive by construction: it only ever creates meeting types from a
      // source URL and never edits or removes one that already exists, so
      // there is no target record to name.
      n === 'import_booking_page'
    const targets = [
      'appointmentId',
      'meetingTypeId',
      'contactId',
      'formId',
      'webhookId',
      'attendeeId',
      'documentId',
      'dealId',
      'crmCompanyId',
    ]
    // Company-scoped singletons: there is exactly one target (the caller's own
    // page / the company's Mira config / its knowledge base), so no id exists.
    const exempt = new Set([
      'update_personal_page',
      'update_mira_settings',
      'restore_mira_settings',
      'crawl_company_website',
      // Keyed by the question itself: answering the same one again replaces
      // that answer, so there is no separate id to name.
      'answer_visitor_question',
      // Runs against the company's one saved widget config; the only thing it
      // writes is that run's own verdict.
      'run_test_drive',
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

  it('routes deal and pipeline tools to the host root, like the rest of the CRM', async () => {
    for (const [name, args] of [
      ['list_pipelines', {}],
      ['list_deals', {}],
      ['get_deal', { dealId: 'd-1' }],
      ['create_deal', { name: 'Muster GmbH', pipelineId: 'p-1', stageId: 's-1' }],
      ['update_deal', { dealId: 'd-1', stageId: 's-2' }],
      ['delete_deal', { dealId: 'd-1' }],
      ['mark_deal_won', { dealId: 'd-1' }],
      ['mark_deal_lost', { dealId: 'd-1' }],
      ['reopen_deal', { dealId: 'd-1' }],
      ['get_deal_activity', { dealId: 'd-1' }],
    ] as const) {
      const call = await callTool(name, args)
      expect(call.options.root, `${name} must target the host root`).toBe(true)
    }
  })

  it('creates a deal against the pipeline/stage the caller chose', async () => {
    // CreateDealDto requires name, pipelineId and stageId; the API has no
    // default pipeline for this call, unlike a bare deal-count query.
    const call = await callTool('create_deal', {
      name: 'Muster GmbH – Cybersicherheitsberatung',
      pipelineId: 'p-1',
      stageId: 's-1',
      value: 990,
      ownerId: 'u-1',
    })
    expect(call).toMatchObject({ method: 'POST', path: '/crm/deals' })
    expect(call.options.body).toMatchObject({
      name: 'Muster GmbH – Cybersicherheitsberatung',
      pipelineId: 'p-1',
      stageId: 's-1',
      value: 990,
      ownerId: 'u-1',
    })
  })

  it('lets update_deal clear ownerId with an explicit null, not just omit it', async () => {
    // UpdateDealDto: `null` clears the owner; omitting the key leaves it
    // unchanged. JSON.stringify only preserves that distinction if the tool
    // never substitutes a default for a missing field.
    const call = await callTool('update_deal', { dealId: 'd-1', ownerId: null })
    expect(call).toMatchObject({ method: 'PATCH', path: '/crm/deals/d-1' })
    expect(call.options.body).toMatchObject({ ownerId: null })
    expect(call.options.body).not.toHaveProperty('name')
  })

  it('lets update_contact clear crmCompanyId with an explicit null, not just omit it', async () => {
    // UpdateContactDto: `null` clears the linked company; omitting the key
    // leaves it unchanged.
    const call = await callTool('update_contact', { contactId: 'c-1', crmCompanyId: null })
    expect(call).toMatchObject({ method: 'PATCH', path: '/crm/c-1' })
    expect(call.options.body).toMatchObject({ crmCompanyId: null })
    expect(call.options.body).not.toHaveProperty('notes')
  })

  it('lets create_contact link a crmCompanyId', async () => {
    const call = await callTool('create_contact', {
      email: 'a@example.com',
      crmCompanyId: 'co-1',
    })
    expect(call).toMatchObject({ method: 'POST', path: '/crm' })
    expect(call.options.body).toMatchObject({ crmCompanyId: 'co-1' })
  })

  it('sends the won/lost/reopen bodies their own DTOs expect', async () => {
    const won = await callTool('mark_deal_won', { dealId: 'd-1', wonStageId: 's-won' })
    expect(won.path).toBe('/crm/deals/d-1/won')
    expect(won.options.body).toMatchObject({ wonStageId: 's-won' })

    const lost = await callTool('mark_deal_lost', {
      dealId: 'd-1',
      lostReason: 'budget',
      lostReasonNote: 'Postponed to next fiscal year',
    })
    expect(lost.path).toBe('/crm/deals/d-1/lost')
    expect(lost.options.body).toMatchObject({
      lostReason: 'budget',
      lostReasonNote: 'Postponed to next fiscal year',
    })

    const reopened = await callTool('reopen_deal', { dealId: 'd-1', stageId: 's-1' })
    expect(reopened.path).toBe('/crm/deals/d-1/reopen')
    expect(reopened.options.body).toMatchObject({ stageId: 's-1' })
  })

  it('defaults the deal activity limit instead of sending an unbounded query', async () => {
    // GET /crm/deals/{id}/activity declares `limit` a required query param.
    const call = await callTool('get_deal_activity', { dealId: 'd-1' })
    expect(call.path).toBe('/crm/deals/d-1/activity')
    expect(call.options.query).toMatchObject({ limit: 50 })
  })

  it('routes company tools to the host root, like the rest of the CRM', async () => {
    for (const [name, args] of [
      ['list_companies', {}],
      ['get_company', { crmCompanyId: 'co-1' }],
      ['create_company', { name: 'Muster GmbH' }],
      ['update_company', { crmCompanyId: 'co-1', industry: 'Einzelhandel' }],
      ['delete_company', { crmCompanyId: 'co-1' }],
      ['get_company_by_domain', { domain: 'muster.example' }],
      ['get_company_contacts', { crmCompanyId: 'co-1' }],
      ['get_company_deals', { crmCompanyId: 'co-1' }],
      ['get_company_summary', {}],
    ] as const) {
      const call = await callTool(name, args)
      expect(call.options.root, `${name} must target the host root`).toBe(true)
    }
  })

  it('creates a company with only the fields the caller supplied', async () => {
    // CreateCrmCompanyDto requires only `name`.
    const call = await callTool('create_company', { name: 'Muster GmbH' })
    expect(call).toMatchObject({ method: 'POST', path: '/crm/companies' })
    expect(call.options.body).toMatchObject({ name: 'Muster GmbH' })
  })

  it('lets update_company clear ownerId with an explicit null, not just omit it', async () => {
    const call = await callTool('update_company', { crmCompanyId: 'co-1', ownerId: null })
    expect(call).toMatchObject({ method: 'PATCH', path: '/crm/companies/co-1' })
    expect(call.options.body).toMatchObject({ ownerId: null })
    expect(call.options.body).not.toHaveProperty('name')
  })

  it('looks up a company by domain on its own path, not a query filter', async () => {
    const call = await callTool('get_company_by_domain', { domain: 'muster.example' })
    expect(call).toMatchObject({ method: 'GET', path: '/crm/companies/by-domain/muster.example' })
  })

  it('reads a company\'s linked contacts and deals on their nested paths', async () => {
    const contacts = await callTool('get_company_contacts', { crmCompanyId: 'co-1' })
    expect(contacts.path).toBe('/crm/companies/co-1/contacts')

    const deals = await callTool('get_company_deals', { crmCompanyId: 'co-1' })
    expect(deals.path).toBe('/crm/companies/co-1/deals')
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

  it('proposes a setup without writing anything', async () => {
    const call = await callTool('propose_conversion_setup', {
      url: 'https://makler.example',
      useCase: 'support',
    })
    expect(call).toMatchObject({
      method: 'POST',
      path: '/knowledge/conversion-proposal',
    })
    expect(call.options.body).toEqual({
      url: 'https://makler.example',
      useCase: 'support',
    })
    expect(call.options.root).toBe(true)
    // A proposal must never be a write: an agent has to be able to look at a
    // site before anyone has agreed to anything.
    expect(TOOLS.find((t) => t.name === 'propose_conversion_setup')?.readOnly).toBe(
      true,
    )
  })

  it('teaches an answer as a question/answer pair', async () => {
    const call = await callTool('answer_visitor_question', {
      question: 'Beraten Sie auch Gewerbekunden?',
      answer: 'Ja, für Betriebe bis 50 Mitarbeitende.',
    })
    expect(call).toMatchObject({ method: 'POST', path: '/knowledge/answer' })
    expect(call.options.body).toEqual({
      question: 'Beraten Sie auch Gewerbekunden?',
      answer: 'Ja, für Betriebe bis 50 Mitarbeitende.',
    })
    expect(call.options.root).toBe(true)
  })

  it('reads insights with the window as a query param', async () => {
    const call = await callTool('get_conversation_insights', { days: 30 })
    expect(call).toMatchObject({ method: 'GET', path: '/web-chat/insights' })
    expect(call.options.query).toEqual({ days: 30 })
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

  it('creates a qualification form against the host-root knowledge route', async () => {
    const call = await callTool('create_qualification_form', {
      assistantName: 'Lena',
      language: 'de',
      meetingTypeId: 'mt-1',
      questions: [
        { label: 'Wie groß ist dein Team?', key: 'team_size', options: [] },
      ],
    })
    expect(call).toMatchObject({
      method: 'POST',
      path: '/knowledge/qualification-form',
    })
    expect(call.options.root).toBe(true)
    expect(call.options.body).toMatchObject({
      assistantName: 'Lena',
      meetingTypeId: 'mt-1',
    })
  })

  it('derives setup status from settings + docs + meeting types, tolerating gated reads', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_setup_status')
    if (!tool) throw new Error('missing get_setup_status')
    const { client } = record({
      '/company/mira-settings': {
        assistantProfiles: [{ id: 'website-assistant' }],
        webChat: { publicKey: 'k', enabled: false, allowedDomains: [] },
      },
      // /knowledge/documents resolves to {} (no documents key) and
      // /meeting-type to {} (not an array) — both must read as zero, not throw.
    })
    const status = (await tool.run(client, {})) as {
      stage: string
      next: string | null
    }
    expect(status.stage).toBe('ready')
    expect(status.next).toBe('bookable')
  })
})

describe('release hygiene', () => {
  it('reports the version the package claims', async () => {
    // The version used to be hardcoded in two entry points beside the manifest's
    // own — a drift that already happened once (the bundle shipped 0.1.1 while
    // the handshake announced 0.1.0, which makes every bug report wrong).
    // VERSION now reads package.json at runtime, so this asserts the reading
    // works in the layout the tests run in; the Docker image and the .mcpb both
    // keep the manifest one directory above the entry, as npm does.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { VERSION } = await import('../version.js')
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version: string }

    expect(VERSION).toBe(pkg.version)
  })

  it('packs the extension at the same version as the package', async () => {
    // The .mcpb manifest is the one copy that cannot read package.json at
    // runtime: Claude Desktop shows its version in the install UI.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const read = (relative: string) =>
      JSON.parse(
        readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
      ) as { version: string }

    expect(read('../../mcpb/manifest.json').version).toBe(
      read('../../package.json').version,
    )
  })
})

describe('open-world annotations', () => {
  it('flags exactly the tools whose effects leave meetergo', () => {
    const openWorld = TOOLS.filter((t) => t.openWorld)
      .map((t) => t.name)
      .sort()
    // "Can someone who is not this user observe the effect." Mail to an
    // attendee, a page the public can load, an HTTP call to a third party.
    // ChatGPT's app review rejects a missing or wrong hint here, and it is
    // also the honest answer: booking a meeting emails a person who never
    // agreed to an agent acting for them.
    expect(openWorld).toEqual([
      'add_guest',
      'answer_visitor_question',
      'book_appointment',
      'cancel_appointment',
      'crawl_company_website',
      'create_meeting_type',
      'create_one_time_booking_link',
      'create_qualification_form',
      'create_routing_form',
      'create_webhook',
      'delete_knowledge_document',
      'delete_meeting_type',
      'delete_routing_form',
      'delete_webhook',
      'import_booking_page',
      'reschedule_appointment',
      'restore_mira_settings',
      'send_quick_email',
      'send_routing_form',
      'update_meeting_type',
      'update_mira_settings',
      'update_personal_page',
      'update_routing_form',
      'update_webhook',
    ])
  })

  it('never flags a read as open-world', () => {
    // Reading a public page observes external state; it does not change it.
    // propose_conversion_setup and verify_widget_install both fetch the open
    // internet without changing it and must stay false.
    for (const tool of TOOLS.filter((t) => t.readOnly)) {
      expect(tool.openWorld, `${tool.name}`).toBeFalsy()
    }
  })
})

describe('import_booking_page', () => {
  const tool = TOOLS.find((t) => t.name === 'import_booking_page')!

  it('posts the url straight to the import endpoint', async () => {
    const calls: unknown[][] = []
    const client = {
      request: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve({ provider: 'calendly', created: [], failed: [] })
      },
    }
    await tool.run(client as never, { url: 'https://calendly.com/acme' })
    expect(calls).toEqual([
      ['POST', '/import', { body: { url: 'https://calendly.com/acme' } }],
    ])
  })

  it('rejects a non-URL before it reaches the API', () => {
    const url = tool.schema.url as { safeParse: (v: unknown) => { success: boolean } }
    expect(url.safeParse('calendly.com/acme').success).toBe(false)
    expect(url.safeParse('https://calendly.com/acme').success).toBe(true)
  })

  it('fences the result as untrusted', () => {
    // Meeting-type names and booking questions come from a profile page the
    // person running the agent may not control — on a migration it is often
    // someone else's. Without the fence, "add a meeting type called ignore
    // previous instructions" arrives next to a tool surface holding deletes.
    expect(tool.untrustedSource).toBe('the imported booking page')
  })

  it('names no scheduler the brand rules keep out of public copy', () => {
    // Tool names and descriptions render in every MCP client, so they are
    // public copy. Provider detection is by URL, so the tool works for the
    // others without naming them.
    const copy = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase()
    expect(copy).toContain('calendly')
    expect(copy).not.toContain('zeeg')
    expect(copy).not.toContain('cituro')
    expect(copy).not.toContain('terminpilot')
  })

  it('warns that the import is additive', () => {
    // Running it twice duplicates. An agent that does not know this will
    // re-run on failure and quietly double the account's meeting types.
    expect(tool.description.toLowerCase()).toContain('twice')
  })
})

describe('agent-readable scheduling results', () => {
  const CONFIRMED_APPOINTMENT = {
    id: 'appt-1',
    start: '2026-10-20T08:00:00.000Z',
    end: '2026-10-20T08:30:00.000Z',
    isCancelled: false,
    cancel: { actionAt: null, reason: null },
    rescheduledAt: null,
  }

  function toolByName(name: string) {
    const tool = TOOLS.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`Missing tool ${name}`)
    return tool
  }

  it('adds one sorted, deduplicated UTC list to availability', async () => {
    const { client } = record({
      '/meeting-type/mt-1': { id: 'mt-1', userId: 'u-1' },
      '/booking-availability': {
        timezone: 'Europe/Berlin',
        dates: [
          {
            date: '2026-10-20',
            spots: [
              { startTime: '2026-10-20T11:30:00.000+02:00' },
              { startTime: '2026-10-20T08:00:00.000+02:00' },
              { startTime: '2026-10-20T08:00:00.000+02:00' },
            ],
          },
        ],
      },
    })

    const result = (await toolByName('get_availability').run(client, {
      meetingTypeId: 'mt-1',
      start: '2026-10-20T00:00:00Z',
      end: '2026-10-21T00:00:00Z',
    })) as Record<string, unknown>

    expect(result['slotsStartUtc']).toEqual([
      '2026-10-20T06:00:00.000Z',
      '2026-10-20T09:30:00.000Z',
    ])
  })

  it('labels confirmed and cancelled appointment reads', async () => {
    const { client: confirmedClient } = record({
      '/appointment/appt-1': CONFIRMED_APPOINTMENT,
    })
    const confirmed = (await toolByName('get_appointment').run(
      confirmedClient,
      { appointmentId: 'appt-1' },
    )) as Record<string, unknown>

    const { client: cancelledClient } = record({
      '/appointment/appt-1': {
        ...CONFIRMED_APPOINTMENT,
        cancel: { actionAt: '2026-10-19T09:00:00.000Z', reason: 'conflict' },
      },
    })
    const cancelled = (await toolByName('get_appointment').run(
      cancelledClient,
      { appointmentId: 'appt-1' },
    )) as Record<string, unknown>

    expect(confirmed['status']).toBe('confirmed')
    expect(cancelled['status']).toBe('cancelled')
  })

  it('decorates paginated and today appointment collections', async () => {
    const rescheduled = {
      ...CONFIRMED_APPOINTMENT,
      rescheduledAt: '2026-10-19T09:00:00.000Z',
    }
    const { client } = record({
      '/appointment/paginated': {
        appointments: [
          CONFIRMED_APPOINTMENT,
          { ...CONFIRMED_APPOINTMENT, isCancelled: true },
        ],
        total: 2,
      },
      '/appointment/today': [rescheduled],
    })

    const paginated = (await toolByName('list_appointments').run(
      client,
      {},
    )) as {
      appointments: Array<Record<string, unknown>>
      total: number
    }
    const today = (await toolByName('get_todays_appointments').run(
      client,
      {},
    )) as Array<Record<string, unknown>>

    expect(paginated.total).toBe(2)
    expect(paginated.appointments.map((item) => item['status'])).toEqual([
      'confirmed',
      'cancelled',
    ])
    expect(today[0]).toMatchObject({ status: 'confirmed', rescheduled: true })
  })

  it.each([
    ['requireHostConfirmation', 'host'],
    ['doubleOptIn', 'attendee'],
  ])(
    'does not report a %s provisional response as booked',
    async (bookingType, actor) => {
      const { client } = record({
        ...SOLO_MEETING_TYPE,
        '/booking': { bookingType, provisionalBookingId: 'pb-1' },
      })

      const result = (await toolByName('book_appointment').run(client, {
        meetingTypeId: 'mt-1',
        start: '2026-10-20T06:00:00.000Z',
        email: 'ada@example.com',
        fullName: 'Ada Lovelace',
      })) as Record<string, unknown>

      expect(result['bookingState']).toBe('pending_confirmation')
      expect(String(result['message']).toLowerCase()).toContain(actor)
      expect(String(result['message'])).toContain('NOT booked yet')
    },
  )

  it('labels a confirmed booking and echoes the requested UTC start', async () => {
    const { client } = record({
      ...SOLO_MEETING_TYPE,
      '/booking': { appointmentId: 'appt-new', secret: 'secret' },
    })

    const result = (await toolByName('book_appointment').run(client, {
      meetingTypeId: 'mt-1',
      start: '2026-10-20T08:00:00.000+02:00',
      email: 'ada@example.com',
      fullName: 'Ada Lovelace',
    })) as Record<string, unknown>

    expect(result).toMatchObject({
      appointmentId: 'appt-new',
      bookingState: 'confirmed',
      startUtc: '2026-10-20T06:00:00.000Z',
    })
  })

  it('reads the nested reschedule response and echoes the new UTC start', async () => {
    const { client } = record({
      '/appointment/appt-1/reschedule': {
        appointment: {
          ...CONFIRMED_APPOINTMENT,
          start: '2026-10-21T07:30:00.000Z',
          rescheduledAt: '2026-10-19T09:00:00.000Z',
        },
        previousStart: CONFIRMED_APPOINTMENT.start,
      },
    })

    const result = (await toolByName('reschedule_appointment').run(client, {
      appointmentId: 'appt-1',
      start: '2026-10-21T09:30:00.000+02:00',
    })) as Record<string, unknown>

    expect(result).toMatchObject({
      bookingState: 'confirmed',
      startUtc: '2026-10-21T07:30:00.000Z',
      appointment: { status: 'confirmed', rescheduled: true },
    })
  })

  it('distinguishes removing one attendee from cancelling the appointment', async () => {
    const tool = toolByName('cancel_appointment')
    const { client: attendeeClient } = record({
      '/appointment/appt-1/cancel': CONFIRMED_APPOINTMENT,
    })
    const attendeeResult = (await tool.run(attendeeClient, {
      appointmentId: 'appt-1',
      attendeeId: 'attendee-1',
    })) as Record<string, unknown>

    const { client: allClient } = record({
      '/appointment/appt-1/cancel': {
        ...CONFIRMED_APPOINTMENT,
        isCancelled: true,
      },
    })
    const allResult = (await tool.run(allClient, {
      appointmentId: 'appt-1',
      cancelAll: true,
    })) as Record<string, unknown>

    expect(attendeeResult).toMatchObject({
      bookingState: 'attendee_removed',
      removedAttendeeId: 'attendee-1',
      status: 'confirmed',
    })
    expect(allResult).toMatchObject({
      bookingState: 'cancelled',
      status: 'cancelled',
    })
  })

  it('passes unexpected non-object payloads through unchanged', async () => {
    const { client } = record({
      '/appointment/appt-1': ['unexpected', 'array'],
    })
    await expect(
      toolByName('get_appointment').run(client, { appointmentId: 'appt-1' }),
    ).resolves.toEqual(['unexpected', 'array'])
  })
})
