import type { MeetergoClient, RequestOptions } from '../client.js'
import { AVAILABILITY_OUTPUTS, AVAILABILITY_TOOLS } from '../tools-availability.js'

interface RecordedCall {
  method: string
  path: string
  options: RequestOptions
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<RecordedCall> {
  const tool = AVAILABILITY_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  const calls: RecordedCall[] = []
  const client = {
    request: (method: string, path: string, options: RequestOptions = {}) => {
      calls.push({ method, path, options })
      return Promise.resolve({})
    },
  } as unknown as MeetergoClient
  await tool.run(client, args)
  expect(calls).toHaveLength(1)
  return calls[0]
}

const week = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
    d,
    { enabled: d === 'monday', hours: d === 'monday' ? [{ start: '09:00', end: '17:00' }] : [] },
  ]),
)

describe('availability schedule tools', () => {
  it('has an output schema per tool, and names that cannot be confused with get_availability', () => {
    expect(Object.keys(AVAILABILITY_OUTPUTS).sort()).toEqual(
      AVAILABILITY_TOOLS.map((t) => t.name).sort(),
    )
    expect(AVAILABILITY_TOOLS.map((t) => t.name)).not.toContain('get_availability')
  })

  it('annotates writes, deletes and reads', () => {
    const by = Object.fromEntries(AVAILABILITY_TOOLS.map((t) => [t.name, t]))
    expect(by.get_availability_schedule.readOnly).toBe(true)
    expect(by.list_availability_exceptions.readOnly).toBe(true)
    for (const n of ['save_availability_schedule', 'availability_schedule_action', 'save_availability_exception']) {
      expect(by[n].readOnly).toBe(false)
    }
    for (const n of ['delete_availability_schedule', 'delete_availability_exception']) {
      expect(by[n]).toMatchObject({ readOnly: false, destructive: true })
    }
  })

  it('reads schedules: list, one, meeting types, many', async () => {
    expect(await callTool('get_availability_schedule', { userId: 'u1' })).toMatchObject({
      method: 'GET',
      path: '/availability',
      options: { query: { userId: 'u1' }, root: true },
    })
    expect(await callTool('get_availability_schedule', { scheduleId: 'a1' })).toMatchObject({
      method: 'GET',
      path: '/availability/a1',
      options: { root: true },
    })
    expect(
      await callTool('get_availability_schedule', { scheduleId: 'a1', meetingTypes: true, userId: 'u1' }),
    ).toMatchObject({
      path: '/availability/a1/meeting-types',
      options: { query: { userId: 'u1' }, root: true },
    })
    expect(await callTool('get_availability_schedule', { userIds: ['u1', 'u2'] })).toMatchObject({
      path: '/availability/many',
      options: { query: { userIds: ['u1', 'u2'] }, root: true },
    })
    await expect(callTool('get_availability_schedule', { meetingTypes: true })).rejects.toThrow(/scheduleId/)
  })

  it('lists exceptions per scope', async () => {
    expect(await callTool('list_availability_exceptions', { scope: 'company' })).toMatchObject({
      method: 'GET',
      path: '/availability-exception/company',
      options: { root: true },
    })
    expect(await callTool('list_availability_exceptions', {})).toMatchObject({
      path: '/availability-exception/user',
    })
  })

  it('creates a schedule with POST /availability', async () => {
    const call = await callTool('save_availability_schedule', {
      name: 'Office',
      timezone: 'Europe/Berlin',
      schedule: week,
      userId: 'u1',
      exceptions: [{ available: false, start: '2026-12-24T00:00:00Z', end: '2026-12-25T00:00:00Z' }],
    })
    expect(call).toMatchObject({ method: 'POST', path: '/availability' })
    expect(call.options.query).toEqual({ userId: 'u1' })
    expect(call.options.root).toBe(true)
    expect(call.options.body).toEqual({
      name: 'Office',
      timezone: 'Europe/Berlin',
      schedule: week,
      exceptions: [{ available: false, start: '2026-12-24T00:00:00Z', end: '2026-12-25T00:00:00Z' }],
    })
    await expect(callTool('save_availability_schedule', { name: 'x' })).rejects.toThrow(/timezone/)
    await expect(
      callTool('save_availability_schedule', { name: 'x', timezone: 'UTC', useExplicitAvailability: true }),
    ).rejects.toThrow(/updating/)
  })

  it('updates a schedule with PATCH and only supplied fields', async () => {
    const call = await callTool('save_availability_schedule', {
      scheduleId: 'a1',
      name: 'Renamed',
      explicitAvailabilityEventTitle: null,
    })
    expect(call).toMatchObject({ method: 'PATCH', path: '/availability/a1' })
    expect(call.options.body).toEqual({ name: 'Renamed', explicitAvailabilityEventTitle: null })
    await expect(
      callTool('save_availability_schedule', { scheduleId: 'a1', exceptions: [] }),
    ).rejects.toThrow(/creating/)
  })

  it('deletes a schedule', async () => {
    expect(await callTool('delete_availability_schedule', { scheduleId: 'a1', userId: 'u1' })).toMatchObject({
      method: 'DELETE',
      path: '/availability/a1',
      options: { query: { userId: 'u1' }, root: true },
    })
  })

  it('maps each action to its route and body', async () => {
    expect(await callTool('availability_schedule_action', { action: 'set_default', scheduleId: 'a1', userId: 'u1' })).toMatchObject({
      method: 'POST',
      path: '/availability/default/a1',
      options: { query: { userId: 'u1' }, root: true },
    })
    const apply = await callTool('availability_schedule_action', {
      action: 'apply_to_users',
      scheduleId: 'a1',
      userIds: ['u1', 'u2'],
      setAsDefault: true,
    })
    expect(apply).toMatchObject({ method: 'POST', path: '/availability/a1/apply-to-users' })
    expect(apply.options.body).toEqual({ userIds: ['u1', 'u2'], setAsDefault: true })
    const hol = await callTool('availability_schedule_action', {
      action: 'add_holidays',
      scheduleId: 'a1',
      year: 2026,
      country: 'DE',
      germanState: 'BY',
    })
    expect(hol).toMatchObject({ method: 'PATCH', path: '/availability/a1/holiday-exceptions' })
    expect(hol.options.body).toEqual({ year: 2026, country: 'DE', germanState: 'BY' })
    const bulk = await callTool('availability_schedule_action', {
      action: 'add_holidays_for_users',
      userIds: ['u1'],
      year: 2026,
      country: 'AT',
    })
    expect(bulk).toMatchObject({ method: 'POST', path: '/availability/bulk-holidays' })
    expect(bulk.options.body).toEqual({ userIds: ['u1'], year: 2026, country: 'AT' })
    await expect(
      callTool('availability_schedule_action', { action: 'apply_to_users', scheduleId: 'a1' }),
    ).rejects.toThrow(/userIds/)
  })

  it('creates user and company exceptions, updates with PUT', async () => {
    const body = { available: false, start: '2026-12-24T00:00:00Z', end: '2026-12-25T00:00:00Z', title: 'Xmas' }
    const user = await callTool('save_availability_exception', { scope: 'user', userId: 'u1', ...body })
    expect(user).toMatchObject({ method: 'POST', path: '/availability-exception/user' })
    expect(user.options.query).toEqual({ userId: 'u1' })
    expect(user.options.body).toEqual(body)
    const company = await callTool('save_availability_exception', { scope: 'company', ...body })
    expect(company).toMatchObject({ method: 'POST', path: '/availability-exception/company' })
    expect(company.options.query).toBeUndefined()
    const put = await callTool('save_availability_exception', { exceptionId: '12', userId: 'u1', ...body })
    expect(put).toMatchObject({ method: 'PUT', path: '/availability-exception/12' })
    expect(put.options.query).toEqual({ userId: 'u1' })
    expect(put.options.body).toEqual(body)
    await expect(callTool('save_availability_exception', body)).rejects.toThrow(/scope/)
  })

  it('deletes an exception', async () => {
    expect(await callTool('delete_availability_exception', { exceptionId: '12' })).toMatchObject({
      method: 'DELETE',
      path: '/availability-exception/12',
      options: { root: true },
    })
  })
})
