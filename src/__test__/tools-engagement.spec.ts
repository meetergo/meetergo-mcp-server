import type { MeetergoClient, RequestOptions } from '../client.js'
import { ENGAGEMENT_TOOLS } from '../tools-engagement.js'

interface RecordedCall {
  method: string
  path: string
  options: RequestOptions
}

/** Records what a tool would put on the wire, same idea as tools.spec.ts. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<RecordedCall> {
  const tool = ENGAGEMENT_TOOLS.find((t) => t.name === name)
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
  // All engagement routes are /v4, so never host-root.
  expect(calls[0].options.root).toBeUndefined()
  return calls[0]
}

const tool = (name: string) => ENGAGEMENT_TOOLS.find((t) => t.name === name)!

describe('engagement tools: annotations', () => {
  it('flags reads as read-only and third-party effects as open-world', () => {
    for (const n of ['get_whatsapp', 'get_signatures', 'list_provisional_bookings', 'list_handoff_options']) {
      expect(tool(n).readOnly).toBe(true)
    }
    for (const n of [
      'send_whatsapp_message',
      'manage_signature',
      'resolve_provisional_booking',
      'handoff_appointments',
      'set_recap_sharing',
      'email_meeting_transcript',
    ]) {
      expect(tool(n).readOnly).toBe(false)
      expect(tool(n).openWorld).toBe(true)
    }
    expect(tool('manage_signature').destructive).toBe(true)
    expect(tool('draft_follow_up_email').openWorld).toBeUndefined()
  })
})

describe('get_whatsapp', () => {
  it('maps every view to its route', async () => {
    expect(await callTool('get_whatsapp', { view: 'senders' })).toMatchObject({ method: 'GET', path: '/whatsapp/senders' })
    expect(await callTool('get_whatsapp', { view: 'templates', phoneNumberId: 'p1' })).toMatchObject({
      path: '/whatsapp/templates',
      options: { query: { phoneNumberId: 'p1' } },
    })
    expect(
      await callTool('get_whatsapp', { view: 'conversations', phone: '+49123', status: 'open', limit: 5, cursor: 'c' }),
    ).toMatchObject({
      path: '/whatsapp/conversations',
      options: { query: { phone: '+49123', status: 'open', limit: 5, cursor: 'c' } },
    })
    expect(await callTool('get_whatsapp', { view: 'conversation', conversationId: 'v1' })).toMatchObject({
      path: '/whatsapp/conversations/v1',
    })
    expect(await callTool('get_whatsapp', { view: 'messages', conversationId: 'v1', limit: 10 })).toMatchObject({
      path: '/whatsapp/conversations/v1/messages',
      options: { query: { limit: 10 } },
    })
    expect(
      await callTool('get_whatsapp', { view: 'feed', since: '2026-06-25T10:00:00.000Z', direction: 'all' }),
    ).toMatchObject({
      path: '/whatsapp/messages',
      options: { query: { since: '2026-06-25T10:00:00.000Z', direction: 'all' } },
    })
  })

  it('rejects a view that lacks its required argument', async () => {
    await expect(callTool('get_whatsapp', { view: 'feed' })).rejects.toThrow(/since/)
    await expect(callTool('get_whatsapp', { view: 'messages' })).rejects.toThrow(/conversationId/)
  })
})

describe('send_whatsapp_message', () => {
  it('posts a text message', async () => {
    const call = await callTool('send_whatsapp_message', { to: '+491234567890', type: 'text', text: 'Hallo' })
    expect(call).toMatchObject({ method: 'POST', path: '/whatsapp/messages' })
    expect(call.options.body).toEqual({ to: '+491234567890', type: 'text', text: 'Hallo' })
  })

  it('posts a template with params and sender', async () => {
    const template = { name: 'reminder', language: 'de', params: ['Ada', 'Di 10:00'] }
    const call = await callTool('send_whatsapp_message', {
      to: '+491234567890',
      type: 'template',
      template,
      phoneNumberId: 'p1',
    })
    expect(call.options.body).toEqual({ to: '+491234567890', type: 'template', template, phoneNumberId: 'p1' })
  })

  it('posts media', async () => {
    const media = { url: 'https://x.test/a.pdf', mimeType: 'application/pdf', filename: 'a.pdf' }
    const call = await callTool('send_whatsapp_message', { to: '+49', type: 'media', media })
    expect(call.options.body).toEqual({ to: '+49', type: 'media', media })
  })

  it('refuses a type without its payload', async () => {
    await expect(callTool('send_whatsapp_message', { to: '+49', type: 'text' })).rejects.toThrow(/text/)
    await expect(callTool('send_whatsapp_message', { to: '+49', type: 'template' })).rejects.toThrow(/template/)
    await expect(callTool('send_whatsapp_message', { to: '+49', type: 'media' })).rejects.toThrow(/media/)
  })
})

describe('get_signatures', () => {
  it('maps every view', async () => {
    expect(await callTool('get_signatures', { view: 'usage' })).toMatchObject({ method: 'GET', path: '/signatures/usage' })
    expect(await callTool('get_signatures', { view: 'list', before: 's9' })).toMatchObject({
      path: '/signatures',
      options: { query: { before: 's9' } },
    })
    expect(await callTool('get_signatures', { view: 'get', id: 's1' })).toMatchObject({ path: '/signatures/s1' })
    expect(await callTool('get_signatures', { view: 'document', id: 's1' })).toMatchObject({
      path: '/signatures/s1/document',
    })
    await expect(callTool('get_signatures', { view: 'get' })).rejects.toThrow(/id/)
  })
})

describe('manage_signature', () => {
  const create = {
    action: 'create',
    name: 'NDA',
    file: 'JVBERi0=',
    fields: [{ name: 'sig', signerKey: 'customer', areas: [{ x: 0.1, y: 0.8, w: 0.3, h: 0.08, page: 1 }] }],
    signers: [{ key: 'customer', email: 'a@b.de', deliveryChannel: 'email' }],
    language: 'de',
  }

  it('creates a request with exactly the supplied fields', async () => {
    const call = await callTool('manage_signature', create)
    expect(call).toMatchObject({ method: 'POST', path: '/signatures' })
    const { action, ...body } = create
    expect(action).toBe('create')
    expect(call.options.body).toEqual(body)
  })

  it('requires exactly one of file and files', async () => {
    const { file, ...noFile } = create
    expect(file).toBeDefined()
    await expect(callTool('manage_signature', noFile)).rejects.toThrow(/file/)
    await expect(callTool('manage_signature', { ...create, files: ['x'] })).rejects.toThrow(/file/)
  })

  it('cancels with DELETE', async () => {
    expect(await callTool('manage_signature', { action: 'cancel', id: 's1' })).toMatchObject({
      method: 'DELETE',
      path: '/signatures/s1',
    })
  })

  it('resends one signer invitation', async () => {
    expect(await callTool('manage_signature', { action: 'resend', id: 's1', signerId: 'g1' })).toMatchObject({
      method: 'POST',
      path: '/signatures/s1/signers/g1/send',
    })
    await expect(callTool('manage_signature', { action: 'resend', id: 's1' })).rejects.toThrow(/signerId/)
  })
})

describe('provisional bookings', () => {
  it('defaults the required paging query', async () => {
    expect(await callTool('list_provisional_bookings')).toMatchObject({
      method: 'GET',
      path: '/provisional-booking/paginated',
      options: { query: { page: 1, pageSize: 20 } },
    })
  })

  it('passes filters through', async () => {
    const call = await callTool('list_provisional_bookings', { page: 2, pageSize: 10, status: 'pending', type: 'requireHostConfirmation' })
    expect(call.options.query).toEqual({ page: 2, pageSize: 10, status: 'pending', type: 'requireHostConfirmation' })
  })

  it('declines with a reason and deletes without a body', async () => {
    const decline = await callTool('resolve_provisional_booking', { id: 'p1', action: 'decline', reason: 'busy' })
    expect(decline).toMatchObject({ method: 'POST', path: '/provisional-booking/p1/decline' })
    expect(decline.options.body).toEqual({ reason: 'busy' })
    const del = await callTool('resolve_provisional_booking', { id: 'p1', action: 'delete' })
    expect(del).toMatchObject({ method: 'DELETE', path: '/provisional-booking/p1' })
    expect(del.options.body).toBeUndefined()
  })
})

describe('handoff', () => {
  it('lists options with its query', async () => {
    expect(await callTool('list_handoff_options', { appointmentId: 'a1', isOnline: true })).toMatchObject({
      method: 'GET',
      path: '/handoff/available-handoffs',
      options: { query: { appointmentId: 'a1', isOnline: true } },
    })
  })

  it('hands off a single appointment to one target', async () => {
    const call = await callTool('handoff_appointments', { appointmentId: 'a1', queueId: 'q1' })
    expect(call).toMatchObject({ method: 'POST', path: '/handoff/appointment' })
    expect(call.options.body).toEqual({ appointmentId: 'a1', queueId: 'q1' })
    await expect(callTool('handoff_appointments', { appointmentId: 'a1' })).rejects.toThrow(/exactly one/)
    await expect(
      callTool('handoff_appointments', { appointmentId: 'a1', userId: 'u', queueId: 'q' }),
    ).rejects.toThrow(/exactly one/)
  })

  it('bulk hands off, renaming fromUserIds to the API userId', async () => {
    const call = await callTool('handoff_appointments', {
      fromUserIds: ['u1'],
      start: '2026-08-01T00:00:00Z',
      end: '2026-08-15T00:00:00Z',
      targetUserIds: ['u2', 'u3'],
      ignoreAvailability: true,
    })
    expect(call).toMatchObject({ method: 'POST', path: '/handoff/bulk' })
    expect(call.options.body).toEqual({
      userId: ['u1'],
      start: '2026-08-01T00:00:00Z',
      end: '2026-08-15T00:00:00Z',
      targetUserIds: ['u2', 'u3'],
      ignoreAvailability: true,
    })
    await expect(
      callTool('handoff_appointments', { fromUserIds: ['u1'], start: 'a', end: 'b' }),
    ).rejects.toThrow(/target/)
  })
})

describe('attendee, follow-up and recap', () => {
  it('marks no-show and patches attendee fields', async () => {
    expect(await callTool('update_attendee', { attendeeId: 'at1', action: 'no_show' })).toMatchObject({
      method: 'POST',
      path: '/attendee/no-show/at1',
    })
    const notes = await callTool('update_attendee', { attendeeId: 'at1', action: 'notes', notes: { company: 'Acme' } })
    expect(notes).toMatchObject({ method: 'PATCH', path: '/attendee/at1/notes' })
    expect(notes.options.body).toEqual({ company: 'Acme' })
    await expect(callTool('update_attendee', { attendeeId: 'at1', action: 'notes' })).rejects.toThrow(/notes/)
  })

  it('drafts a follow-up', async () => {
    const call = await callTool('draft_follow_up_email', { appointmentId: 'a1', language: 'de' })
    expect(call).toMatchObject({ method: 'POST', path: '/appointment/a1/follow-up-draft' })
    expect(call.options.body).toEqual({ language: 'de' })
  })

  it('shares and unshares a recap', async () => {
    expect(await callTool('set_recap_sharing', { appointmentId: 'a1', shared: true })).toMatchObject({
      method: 'POST',
      path: '/appointment/a1/recap/share',
    })
    expect(await callTool('set_recap_sharing', { appointmentId: 'a1', shared: false })).toMatchObject({
      path: '/appointment/a1/recap/unshare',
    })
  })

  it('emails meeting notes', async () => {
    const call = await callTool('email_meeting_transcript', { to: 'a@b.de', meetingTitle: 'Sync', summary: '# s' })
    expect(call).toMatchObject({ method: 'POST', path: '/meeting-transcript/email' })
    expect(call.options.body).toEqual({ to: 'a@b.de', meetingTitle: 'Sync', summary: '# s' })
  })
})
