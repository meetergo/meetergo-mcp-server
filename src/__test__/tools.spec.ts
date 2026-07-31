import type { MeetergoClient, RequestOptions } from '../client.js'
import { TOOLS } from '../tools.js'

/**
 * These assertions are about the agent contract, not implementation detail.
 * A tool renamed or an annotation flipped silently changes what a host will
 * auto-run without asking a human — that is worth a failing test.
 */
describe('meetergo MCP tool surface', () => {
  it('exposes a curated surface, not the whole API', () => {
    // 100 operations exist. This ceiling is deliberate: tool definitions cost
    // context, and selection accuracy falls as the list grows. Raising it
    // should be a decision, not a drift.
    expect(TOOLS).toHaveLength(17)
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length)
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
    // means an agent books or cancels without anyone being asked.
    expect(writes).toEqual([
      'add_guest',
      'book_appointment',
      'cancel_appointment',
      'create_contact',
      'create_one_time_booking_link',
      'reschedule_appointment',
      'update_appointment_notes',
      'update_contact',
    ])
  })

  it('marks only irreversible tools destructive', () => {
    const destructive = TOOLS.filter((t) => t.destructive).map((t) => t.name)
    expect(destructive).toEqual(['cancel_appointment'])
  })

  it('gives every tool a description an agent can choose on', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.title).toBeTruthy()
    }
  })

  it('requires an identifier on every tool that changes an existing record', () => {
    const creates = new Set(['create_contact'])
    for (const tool of TOOLS.filter((t) => !t.readOnly && !creates.has(t.name))) {
      const keys = Object.keys(tool.schema)
      expect(keys.length).toBeGreaterThan(0)
      // Nothing that edits an existing thing should be callable with no target.
      expect(
        keys.some(
          (k) => k === 'appointmentId' || k === 'meetingTypeId' || k === 'contactId',
        ),
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

  it('refuses a contact lookup with no identifier', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_contact')!
    const { client } = record()
    await expect(tool.run(client, {})).rejects.toThrow(/contactId or attendeeId/)
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
