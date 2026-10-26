import type { MeetergoClient } from '../client.js'
import { BOOKING_SETUP_OUTPUTS, BOOKING_SETUP_TOOLS } from '../tools-booking-setup.js'

/** Fakes the client and records every request so the wire shape can be asserted. */
function run(name: string, args: Record<string, unknown>) {
  const tool = BOOKING_SETUP_TOOLS.find((t) => t.name === name)!
  const calls: unknown[][] = []
  const client = {
    request: (...a: unknown[]) => {
      calls.push(a)
      return Promise.resolve({})
    },
  } as unknown as MeetergoClient
  return { tool, calls, done: () => tool.run(client, args) }
}

async function call(name: string, args: Record<string, unknown>) {
  const r = run(name, args)
  await r.done()
  return r.calls
}

describe('booking setup tools', () => {
  it('has an output schema per tool and annotates reads and writes', () => {
    for (const t of BOOKING_SETUP_TOOLS) expect(BOOKING_SETUP_OUTPUTS[t.name]).toBeDefined()
    expect(Object.keys(BOOKING_SETUP_OUTPUTS).sort()).toEqual(
      BOOKING_SETUP_TOOLS.map((t) => t.name).sort(),
    )
    const reads = BOOKING_SETUP_TOOLS.filter((t) => t.readOnly).map((t) => t.name)
    expect(reads.sort()).toEqual([
      'get_calendar_connection_options',
      'list_booking_links',
      'list_meeting_type_templates',
      'list_queues',
      'list_users',
    ])
    for (const t of BOOKING_SETUP_TOOLS.filter((x) => x.readOnly)) {
      expect(t.destructive).toBeUndefined()
      expect(t.openWorld).toBeUndefined()
    }
    for (const n of [
      'delete_meeting_type_template',
      'delete_group_booking_link',
      'disconnect_calendar_connection',
      'manage_queue_user_group',
      'assign_meeting_type_template',
    ])
      expect(BOOKING_SETUP_TOOLS.find((t) => t.name === n)!.destructive).toBe(true)
  })

  describe('templates', () => {
    it('lists, gets and includes', async () => {
      expect(await call('list_meeting_type_templates', {})).toEqual([
        ['GET', '/meeting-type-template/all'],
      ])
      expect(await call('list_meeting_type_templates', { templateId: 't1' })).toEqual([
        ['GET', '/meeting-type-template/t1'],
      ])
      expect(
        await call('list_meeting_type_templates', { templateId: 't1', include: 'meetingTypes' }),
      ).toEqual([['GET', '/meeting-type-template/users/t1']])
      expect(
        await call('list_meeting_type_templates', { templateId: 't1', include: 'workspaces' }),
      ).toEqual([['GET', '/meeting-type-template/workspaces/t1']])
      await expect(call('list_meeting_type_templates', { include: 'workspaces' })).rejects.toThrow()
    })

    it('creates with nested meetingInfo and top-level options', async () => {
      expect(
        await call('save_meeting_type_template', {
          name: 'Intro',
          description: '',
          duration: 30,
          channel: 'zoom',
          allowHostSelection: true,
          templateType: 'team',
          queueType: 'simpleRoundRobin',
          spots: 1,
          contactTags: ['webinar'],
        }),
      ).toEqual([
        [
          'POST',
          '/meeting-type-template/create',
          {
            body: {
              meetingInfo: { name: 'Intro', description: '', duration: 30, channel: 'zoom' },
              meetingOptions: { allowHostSelection: true },
              spots: 1,
              templateType: 'team',
              queueType: 'simpleRoundRobin',
              contactTags: ['webinar'],
            },
          },
        ],
      ])
      await expect(call('save_meeting_type_template', { name: 'x' })).rejects.toThrow(/needs/)
    })

    it('patches only what was sent', async () => {
      expect(
        await call('save_meeting_type_template', {
          templateId: 't1',
          duration: 45,
          lockedFields: ['duration'],
        }),
      ).toEqual([
        [
          'PATCH',
          '/meeting-type-template/t1',
          { body: { meetingInfo: { duration: 45 }, lockedFields: ['duration'] } },
        ],
      ])
      expect(await call('save_meeting_type_template', { templateId: 't1', spots: 3 })).toEqual([
        ['PATCH', '/meeting-type-template/t1', { body: { spots: 3 } }],
      ])
    })

    it('assigns, bulk assigns, assigns a workspace and unassigns', async () => {
      expect(
        await call('assign_meeting_type_template', { templateId: 't1', action: 'assign_host', userId: 'u1' }),
      ).toEqual([['POST', '/meeting-type-template/assign/t1', { body: { userId: 'u1' } }]])
      expect(
        await call('assign_meeting_type_template', {
          templateId: 't1',
          action: 'assign_hosts',
          userIds: ['u1', 'u2'],
        }),
      ).toEqual([['POST', '/meeting-type-template/assign-bulk/t1', { body: { userIds: ['u1', 'u2'] } }]])
      expect(
        await call('assign_meeting_type_template', {
          templateId: 't1',
          action: 'assign_workspace',
          workspaceId: 'w1',
        }),
      ).toEqual([
        ['POST', '/meeting-type-template/assign-workspace/t1', { body: { workspaceId: 'w1' } }],
      ])
      expect(await call('assign_meeting_type_template', { templateId: 't1', action: 'unassign' })).toEqual([
        ['POST', '/meeting-type-template/unassign/t1'],
      ])
      await expect(
        call('assign_meeting_type_template', { templateId: 't1', action: 'assign_host' }),
      ).rejects.toThrow()
    })

    it('deletes', async () => {
      expect(await call('delete_meeting_type_template', { templateId: 't1' })).toEqual([
        ['DELETE', '/meeting-type-template/t1'],
      ])
    })
  })

  describe('queues', () => {
    it('picks the endpoint from the arguments', async () => {
      expect(await call('list_queues', {})).toEqual([['GET', '/queue/company']])
      expect(await call('list_queues', { workspaceId: 'w1' })).toEqual([['GET', '/queue/workspace/w1']])
      expect(await call('list_queues', { queueId: 'q1' })).toEqual([['GET', '/queue/q1']])
      expect(await call('list_queues', { queueId: 'q1', next: true })).toEqual([['GET', '/queue/q1/next']])
      await expect(call('list_queues', { next: true })).rejects.toThrow()
    })

    it('patches the meeting-type queue without the deprecated userId', async () => {
      expect(
        await call('update_queue', {
          meetingTypeId: 'm1',
          userIds: ['u1'],
          type: 'equalDistribution',
          distributionPeriod: 'week',
          userPriorities: [{ userId: 'u1', priority: 2 }],
        }),
      ).toEqual([
        [
          'PATCH',
          '/queue/meeting-type/m1',
          {
            body: {
              userIds: ['u1'],
              type: 'equalDistribution',
              distributionPeriod: 'week',
              userPriorities: [{ userId: 'u1', priority: 2 }],
            },
          },
        ],
      ])
    })

    it('creates, updates and deletes user groups', async () => {
      expect(await call('manage_queue_user_group', { action: 'create', queueId: 'q1', name: 'DACH' })).toEqual([
        ['POST', '/queue-user-group', { body: { queueId: 'q1', name: 'DACH' } }],
      ])
      expect(
        await call('manage_queue_user_group', {
          action: 'update',
          groupId: 'g1',
          userIds: ['u1'],
          mainGroupHostId: null,
          capacity: 2,
        }),
      ).toEqual([
        [
          'PATCH',
          '/queue-user-group/g1',
          { body: { userIds: ['u1'], mainGroupHostId: null, capacity: 2 } },
        ],
      ])
      expect(await call('manage_queue_user_group', { action: 'delete', groupId: 'g1' })).toEqual([
        ['DELETE', '/queue-user-group/g1'],
      ])
      await expect(call('manage_queue_user_group', { action: 'create', name: 'x' })).rejects.toThrow()
    })
  })

  describe('booking links', () => {
    it('reads each scope', async () => {
      expect(await call('list_booking_links', { scope: 'group', workspaceId: 'w1' })).toEqual([
        ['GET', '/booking-link/group/workspace/w1'],
      ])
      expect(await call('list_booking_links', { scope: 'workspace' })).toEqual([
        ['GET', '/booking-link', { query: {} }],
      ])
      expect(await call('list_booking_links', { scope: 'workspace', workspaceId: 'w1' })).toEqual([
        ['GET', '/booking-link', { query: { workspaceId: 'w1' } }],
      ])
      expect(await call('list_booking_links', { scope: 'all', domain: 'd', id: 'i' })).toEqual([
        ['GET', '/booking-link/all', { query: { domain: 'd', id: 'i' } }],
      ])
      expect(await call('list_booking_links', { scope: 'assigned' })).toEqual([
        ['GET', '/booking-link/personal-link/assigned'],
      ])
      expect(
        await call('list_booking_links', { scope: 'meeting_type', userId: 'u1', meetingTypeId: 'm1' }),
      ).toEqual([['GET', '/booking-link/user/u1/meetingType/m1']])
      expect(await call('list_booking_links', { scope: 'personal_page' })).toEqual([
        ['GET', '/booking-link/personal-page/link'],
      ])
      // Live: the API answers without domain and id, and returns the personal
      // and workspace links, so they only narrow the result.
      expect(await call('list_booking_links', { scope: 'all' })).toEqual([['GET', '/booking-link/all', { query: {} }]])
    })

    it('creates, updates and deletes group links', async () => {
      expect(
        await call('save_group_booking_link', { workspaceId: 'w1', meetingTypeId: 'm1', hostIds: ['u1'] }),
      ).toEqual([
        ['POST', '/booking-link/group', { body: { workspaceId: 'w1', meetingTypeId: 'm1', hostIds: ['u1'] } }],
      ])
      expect(await call('save_group_booking_link', { groupBookingLinkId: 'l1', hostIds: ['u2'] })).toEqual([
        ['PATCH', '/booking-link/group/l1', { body: { hostIds: ['u2'] } }],
      ])
      await expect(call('save_group_booking_link', { workspaceId: 'w1' })).rejects.toThrow()
      expect(await call('delete_group_booking_link', { groupBookingLinkId: 'l1' })).toEqual([
        ['DELETE', '/booking-link/group/l1'],
      ])
    })
  })

  describe('users', () => {
    it('lists with filters and gets one', async () => {
      expect(await call('list_users', { userType: 'standard', limit: 20, offset: 0 })).toEqual([
        ['GET', '/user', { query: { userType: 'standard', limit: 20, offset: 0 } }],
      ])
      expect(await call('list_users', { userId: 'u1' })).toEqual([['GET', '/user/u1']])
    })
  })

  describe('calendar connections', () => {
    it('lists calendars or builds an auth url', async () => {
      expect(await call('get_calendar_connection_options', { connectionId: 'c1' })).toEqual([
        ['GET', '/calendar-connections/connections/c1/calendars', { query: {} }],
      ])
      expect(
        await call('get_calendar_connection_options', {
          provider: 'google',
          redirectUrl: 'https://x.test/ok',
          setAsCalendarSync: true,
          userId: 'u1',
        }),
      ).toEqual([
        [
          'GET',
          '/calendar-connections/auth/google/url',
          { query: { redirectUrl: 'https://x.test/ok', userId: 'u1', setAsCalendarSync: true } },
        ],
      ])
      await expect(call('get_calendar_connection_options', {})).rejects.toThrow()
    })

    it('updates, sets primary and disconnects', async () => {
      expect(
        await call('update_calendar_connection', {
          connectionId: 'c1',
          selectedCalendars: ['primary'],
          validateAvailability: true,
          userId: 'u1',
        }),
      ).toEqual([
        [
          'PATCH',
          '/calendar-connections/connections/c1',
          { query: { userId: 'u1' }, body: { selectedCalendars: ['primary'], validateAvailability: true } },
        ],
      ])
      expect(await call('update_calendar_connection', { connectionId: 'c1', setPrimary: true })).toEqual([
        ['POST', '/calendar-connections/connections/c1/set-primary', { query: {} }],
      ])
      expect(await call('disconnect_calendar_connection', { connectionId: 'c1' })).toEqual([
        ['DELETE', '/calendar-connections/connections/c1', { query: {} }],
      ])
    })

    it('sets or clears the calendar sync provider', async () => {
      expect(
        await call('set_calendar_sync', { userId: 'u1', connectionId: 'c1', provider: 'google' }),
      ).toEqual([
        [
          'PATCH',
          '/user/u1/calendar-sync',
          { body: { id: 'u1', calendarSyncProviders: { id: 'c1', type: 'google' } } },
        ],
      ])
      expect(await call('set_calendar_sync', { userId: 'u1', clear: true })).toEqual([
        ['PATCH', '/user/u1/calendar-sync', { body: { id: 'u1', calendarSyncProviders: null } }],
      ])
      await expect(call('set_calendar_sync', { userId: 'u1' })).rejects.toThrow()
    })
  })
})
