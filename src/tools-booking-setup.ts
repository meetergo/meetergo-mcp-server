/**
 * Booking setup beyond a single meeting type: meeting-type templates, round
 * robin queues, group booking links, platform users (read only) and calendar
 * connection management.
 *
 * All paths are `/v4/...` in the spec and the client base URL already ends in
 * /v4, so none of these need `root: true`. Skipped on purpose: the public page
 * data endpoints under /booking-link (widget internals), the OAuth callback,
 * and user create/update/delete (see the final report of the change).
 *
 * Template request bodies: the spec types `meetingInfo`/`meetingOptions` with
 * the response classes (every field required). The meeting-type routes accept
 * the partial form, so this sends only what the caller set, like
 * create_meeting_type does. Confirm the template create route live.
 */
import { z } from 'zod'
import type { ToolDefinition } from './tools.js'
import { definedOnly, listLimit, listOffset } from './tool-helpers.js'
import { any, bool, list, num, out, record, str } from './output-helpers.js'

const CHANNELS = [
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
  'jitsi',
  'nextcloudTalk',
  'openTalk',
  'alfaview',
] as const

const CALENDAR_PROVIDERS = ['google', 'outlook', 'icloud', 'caldav', 'exchange', 'smart-we', 'ics'] as const
const SYNC_PROVIDERS = [
  'google',
  'outlook',
  'icloud',
  'caldav',
  'exchange',
  'nextcloud',
  'smart-we',
  'salesforce',
] as const
const QUEUE_TYPES = ['simpleRoundRobin', 'advancedRoundRobin', 'equalDistribution'] as const

const need = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(message)
}

const templateShape = {
  name: z.string().optional().describe('Meeting type name. Required on create.'),
  description: z.string().optional().describe('Required on create. Pass "" for none.'),
  duration: z.number().int().min(5).max(480).optional().describe('Minutes. Required on create.'),
  channel: z.enum(CHANNELS).optional().describe('Meeting location type. Required on create.'),
  bufferBefore: z.number().int().min(0).max(120).optional().describe('Minutes'),
  bufferAfter: z.number().int().min(0).max(120).optional().describe('Minutes'),
  allowedDurations: z.array(z.number().int().min(5).max(480)).optional().describe('Extra duration options in minutes'),
  allowHostSelection: z.boolean().optional().describe('Let attendees pick the host (round robin)'),
  allowAddingGuests: z.boolean().optional(),
  templateType: z
    .enum(['individual', 'team'])
    .optional()
    .describe('individual: assigned to users. team: assigned to workspaces.'),
  queueType: z.enum(QUEUE_TYPES).optional().describe('Queue type, for team templates'),
  spots: z.number().int().min(1).optional().describe('Attendees per slot'),
  locations: z.array(z.string()).optional(),
  contactTags: z
    .array(z.string().max(64))
    .max(10)
    .optional()
    .describe('CRM tags added to everyone who books. Empty array stops tagging.'),
  sendHostCalendarInvite: z.boolean().optional(),
}

export const BOOKING_SETUP_TOOLS: ToolDefinition[] = [
  // ---- Meeting-type templates ---------------------------------------------
  {
    name: 'list_meeting_type_templates',
    title: 'List meeting type templates',
    description:
      'Without templateId: all templates. With templateId: that template, or with include the meeting types made from it (per user) or the workspaces it is assigned to.',
    schema: {
      templateId: z.string().optional(),
      include: z
        .enum(['meetingTypes', 'workspaces'])
        .optional()
        .describe('Needs templateId. meetingTypes: copies made for users. workspaces: team assignments.'),
    },
    readOnly: true,
    run: (client, { templateId, include }) => {
      if (include) need(templateId, 'include needs templateId')
      if (!templateId) return client.request('GET', '/meeting-type-template/all')
      if (include === 'meetingTypes')
        return client.request('GET', `/meeting-type-template/users/${templateId}`)
      if (include === 'workspaces')
        return client.request('GET', `/meeting-type-template/workspaces/${templateId}`)
      return client.request('GET', `/meeting-type-template/${templateId}`)
    },
  },
  {
    name: 'save_meeting_type_template',
    title: 'Create or update a meeting type template',
    description:
      'Create a template (no templateId; needs name, description, duration, channel) or change one (with templateId; only sent fields change). Updates propagate to meeting types already made from the template, so confirm first.',
    schema: {
      templateId: z.string().optional().describe('Set to update. Omit to create.'),
      ...templateShape,
      lockedFields: z
        .array(z.string())
        .optional()
        .describe('Update only: field keys assigned users cannot change'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: (client, args) => {
      const { templateId, lockedFields, templateType, queueType, spots, locations, contactTags, sendHostCalendarInvite } =
        args
      const info = definedOnly({
        name: args.name,
        description: args.description,
        duration: args.duration,
        channel: args.channel,
        bufferBefore: args.bufferBefore,
        bufferAfter: args.bufferAfter,
      })
      const opts = definedOnly({
        allowedDurations: args.allowedDurations,
        allowHostSelection: args.allowHostSelection,
        allowAddingGuests: args.allowAddingGuests,
      })
      const rest = definedOnly({
        spots,
        locations,
        templateType,
        queueType,
        contactTags,
        sendHostCalendarInvite,
      })
      if (!templateId) {
        need(
          args.name !== undefined &&
            args.description !== undefined &&
            args.duration !== undefined &&
            args.channel !== undefined,
          'Creating a template needs name, description, duration and channel',
        )
        need(lockedFields === undefined, 'lockedFields can only be set on update')
        return client.request('POST', '/meeting-type-template/create', {
          body: {
            meetingInfo: info,
            meetingOptions: opts,
            ...rest,
          },
        })
      }
      return client.request('PATCH', `/meeting-type-template/${templateId}`, {
        body: {
          ...(Object.keys(info).length ? { meetingInfo: info } : {}),
          ...(Object.keys(opts).length ? { meetingOptions: opts } : {}),
          ...rest,
          ...(lockedFields !== undefined ? { lockedFields } : {}),
        },
      })
    },
  },
  {
    name: 'assign_meeting_type_template',
    title: 'Assign or unassign a template',
    description:
      'assign_host / assign_hosts (up to 100) give users a meeting type made from the template; assign_workspace does that for a team workspace; unassign removes the template assignment. Creates or removes bookable pages, so confirm first.',
    schema: {
      templateId: z.string(),
      action: z.enum(['assign_host', 'assign_hosts', 'assign_workspace', 'unassign']),
      userId: z.string().optional().describe('For assign_host'),
      userIds: z.array(z.string()).max(100).optional().describe('For assign_hosts'),
      workspaceId: z.string().optional().describe('For assign_workspace'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: (client, { templateId, action, userId, userIds, workspaceId }) => {
      const base = `/meeting-type-template`
      switch (action) {
        case 'assign_host':
          need(userId, 'assign_host needs userId')
          return client.request('POST', `${base}/assign/${templateId}`, { body: { userId } })
        case 'assign_hosts':
          need(userIds?.length, 'assign_hosts needs userIds')
          return client.request('POST', `${base}/assign-bulk/${templateId}`, { body: { userIds } })
        case 'assign_workspace':
          need(workspaceId, 'assign_workspace needs workspaceId')
          return client.request('POST', `${base}/assign-workspace/${templateId}`, {
            body: { workspaceId },
          })
        default:
          // The spec lists no body or parameter beyond the template id.
          return client.request('POST', `${base}/unassign/${templateId}`)
      }
    },
  },
  {
    name: 'delete_meeting_type_template',
    title: 'Delete a meeting type template',
    description: 'Delete a meeting type template. Confirm with the user first.',
    schema: { templateId: z.string() },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: (client, { templateId }) =>
      client.request('DELETE', `/meeting-type-template/${templateId}`),
  },

  // ---- Queues -------------------------------------------------------------
  {
    name: 'list_queues',
    title: 'List round robin queues',
    description:
      'No arguments: all queues of the company. workspaceId: queues of that workspace. queueId: one queue, or with next the hosts who are next in line.',
    schema: {
      queueId: z.string().optional(),
      workspaceId: z.string().optional(),
      next: z.boolean().optional().describe('Needs queueId. Return the next available hosts.'),
    },
    readOnly: true,
    run: (client, { queueId, workspaceId, next }) => {
      need(!(queueId && workspaceId), 'Pass queueId or workspaceId, not both')
      if (next) need(queueId, 'next needs queueId')
      if (queueId) return client.request('GET', `/queue/${queueId}${next ? '/next' : ''}`)
      if (workspaceId) return client.request('GET', `/queue/workspace/${workspaceId}`)
      return client.request('GET', '/queue/company')
    },
  },
  {
    name: 'update_queue',
    title: 'Update the queue of a meeting type',
    description:
      'Change who hosts a round robin meeting type and how bookings are distributed. userIds is the FULL desired host set and replaces the current one, so read the queue first and confirm with the user.',
    schema: {
      meetingTypeId: z.string(),
      userIds: z.array(z.string()).optional().describe('Full host set; replaces the current hosts'),
      type: z.enum(QUEUE_TYPES).optional(),
      userCapacities: z
        .array(z.object({ userId: z.string(), capacity: z.number() }))
        .optional(),
      userPriorities: z
        .array(z.object({ userId: z.string(), priority: z.number() }))
        .optional()
        .describe('Higher priority is booked first'),
      userCustomLinks: z
        .array(z.object({ userId: z.string(), link: z.string() }))
        .optional()
        .describe('Per-host meeting link; "" falls back to the meeting type default'),
      maxLeadThreshold: z
        .number()
        .min(1)
        .optional()
        .describe('Max bookings a host can be ahead before their slots are hidden'),
      distributionPeriod: z.enum(['day', 'week', 'month']).optional(),
      prioritizeNearTermAvailability: z.boolean().optional(),
    },
    readOnly: false,
    destructive: true,
    run: (client, { meetingTypeId, ...body }) =>
      client.request('PATCH', `/queue/meeting-type/${meetingTypeId}`, {
        body: definedOnly(body),
      }),
  },
  {
    name: 'manage_queue_user_group',
    title: 'Manage a queue user group',
    description:
      'Create, update or delete a host group inside a queue. update: userIds is the FULL member set and replaces the current one; mainGroupHostId null removes the main host. delete cannot be undone, confirm first.',
    schema: {
      action: z.enum(['create', 'update', 'delete']),
      queueId: z.string().optional().describe('For create'),
      groupId: z.string().optional().describe('For update and delete'),
      name: z.string().optional().describe('Required on create'),
      capacity: z.number().min(1).optional(),
      userIds: z.array(z.string()).optional(),
      mainGroupHostId: z.string().nullable().optional(),
    },
    readOnly: false,
    destructive: true,
    run: (client, { action, queueId, groupId, name, ...rest }) => {
      if (action === 'create') {
        need(queueId && name, 'create needs queueId and name')
        return client.request('POST', '/queue-user-group', { body: { queueId, name } })
      }
      need(groupId, `${action} needs groupId`)
      if (action === 'delete') return client.request('DELETE', `/queue-user-group/${groupId}`)
      return client.request('PATCH', `/queue-user-group/${groupId}`, {
        body: definedOnly({ name, ...rest }),
      })
    },
  },

  // ---- Booking links ------------------------------------------------------
  {
    name: 'list_booking_links',
    title: 'List booking links',
    description:
      'Read booking links. scope group: group booking links of a workspace (workspaceId). workspace: personal and workspace links (workspaceId optional, defaults to the user workspace). all: every link with scopes (domain and id). assigned: meeting types on the personal link. meeting_type: link for one host and meeting type (userId, meetingTypeId). personal_page: the personal page link.',
    schema: {
      scope: z.enum(['group', 'workspace', 'all', 'assigned', 'meeting_type', 'personal_page']),
      workspaceId: z.string().optional(),
      domain: z.string().optional().describe('For scope all'),
      id: z.string().optional().describe('For scope all'),
      userId: z.string().optional().describe('For scope meeting_type'),
      meetingTypeId: z.string().optional().describe('For scope meeting_type'),
    },
    readOnly: true,
    run: (client, { scope, workspaceId, domain, id, userId, meetingTypeId }) => {
      switch (scope) {
        case 'group':
          need(workspaceId, 'group needs workspaceId')
          return client.request('GET', `/booking-link/group/workspace/${workspaceId}`)
        case 'workspace':
          return client.request('GET', '/booking-link', { query: definedOnly({ workspaceId }) })
        case 'all':
          need(domain && id, 'all needs domain and id')
          return client.request('GET', '/booking-link/all', { query: { domain, id } })
        case 'assigned':
          return client.request('GET', '/booking-link/personal-link/assigned')
        case 'meeting_type':
          need(userId && meetingTypeId, 'meeting_type needs userId and meetingTypeId')
          return client.request('GET', `/booking-link/user/${userId}/meetingType/${meetingTypeId}`)
        default:
          return client.request('GET', '/booking-link/personal-page/link')
      }
    },
  },
  {
    name: 'save_group_booking_link',
    title: 'Create or update a group booking link',
    description:
      'Create a group booking link (no groupBookingLinkId; needs workspaceId, meetingTypeId, hostIds) or change one (with groupBookingLinkId; hostIds replaces the host list). The link is publicly bookable, so confirm first.',
    schema: {
      groupBookingLinkId: z.string().optional().describe('Set to update. Omit to create.'),
      workspaceId: z.string().optional().describe('Create only'),
      meetingTypeId: z.string().optional(),
      hostIds: z.array(z.string()).optional(),
    },
    readOnly: false,
    openWorld: true,
    run: (client, { groupBookingLinkId, workspaceId, meetingTypeId, hostIds }) => {
      if (!groupBookingLinkId) {
        need(workspaceId && meetingTypeId && hostIds, 'Creating needs workspaceId, meetingTypeId and hostIds')
        return client.request('POST', '/booking-link/group', {
          body: { workspaceId, meetingTypeId, hostIds },
        })
      }
      need(workspaceId === undefined, 'workspaceId cannot be changed on update')
      return client.request('PATCH', `/booking-link/group/${groupBookingLinkId}`, {
        body: definedOnly({ meetingTypeId, hostIds }),
      })
    },
  },
  {
    name: 'delete_group_booking_link',
    title: 'Delete a group booking link',
    description: 'Delete a group booking link. The public link stops working. Confirm first.',
    schema: { groupBookingLinkId: z.string() },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: (client, { groupBookingLinkId }) =>
      client.request('DELETE', `/booking-link/group/${groupBookingLinkId}`),
  },

  // ---- Users (read only) --------------------------------------------------
  {
    name: 'list_users',
    title: 'List users',
    description:
      'Company users with ids, names, email and type. With userId, one user. Use it to find host ids for queues, templates and group links.',
    schema: {
      userId: z.string().optional(),
      userType: z
        .enum(['standard', 'resource', 'api-platform', 'partner', 'viewer'])
        .optional()
        .describe('Filter; ignored with userId'),
      limit: listLimit,
      offset: listOffset,
    },
    readOnly: true,
    run: (client, { userId, userType, limit, offset }) =>
      userId
        ? client.request('GET', `/user/${userId}`)
        : client.request('GET', '/user', { query: definedOnly({ userType, limit, offset }) }),
  },

  // ---- Calendar connections -----------------------------------------------
  {
    name: 'get_calendar_connection_options',
    title: 'Calendar connection options',
    description:
      'With connectionId: the calendars of that connection (ids for a calendar connection update). With provider: an OAuth URL the user opens to connect a new calendar. Connecting happens in the browser, not here.',
    schema: {
      connectionId: z.string().optional(),
      provider: z.enum(CALENDAR_PROVIDERS).optional(),
      redirectUrl: z.string().url().optional().describe('Where to return after OAuth. Provider only.'),
      setAsCalendarSync: z
        .boolean()
        .optional()
        .describe('Also make it the calendar sync provider if none is set. Provider only.'),
      userId: z.string().optional().describe('Admin only: act for another user'),
    },
    readOnly: true,
    run: (client, { connectionId, provider, redirectUrl, setAsCalendarSync, userId }) => {
      need(!!connectionId !== !!provider, 'Pass exactly one of connectionId or provider')
      if (connectionId)
        return client.request('GET', `/calendar-connections/connections/${connectionId}/calendars`, {
          query: definedOnly({ userId }),
        })
      return client.request('GET', `/calendar-connections/auth/${provider}/url`, {
        query: definedOnly({ redirectUrl, userId, setAsCalendarSync }),
      })
    },
  },
  {
    name: 'update_calendar_connection',
    title: 'Update a calendar connection',
    description:
      'Change which calendars block availability, where new events are written and sync behaviour, or make the connection primary (setPrimary). Wrong settings can cause double bookings, so confirm first. Only sent fields change.',
    schema: {
      connectionId: z.string(),
      setPrimary: z.boolean().optional().describe('true: make this the primary connection. Other fields are then ignored.'),
      primaryCalendar: z.string().optional().describe('Calendar id for new events, e.g. "primary"'),
      selectedCalendars: z.array(z.string()).optional().describe('Calendar ids checked for conflicts; replaces the list'),
      validateAvailability: z.boolean().optional(),
      cancelIfDeclinedOrDeleted: z.boolean().optional(),
      disableAttendeeNotification: z.boolean().optional(),
      syncBuffersToCalendar: z.boolean().optional(),
      userId: z.string().optional().describe('Admin only: act for another user'),
    },
    readOnly: false,
    run: (client, { connectionId, setPrimary, userId, ...body }) => {
      const query = definedOnly({ userId })
      if (setPrimary)
        return client.request(
          'POST',
          `/calendar-connections/connections/${connectionId}/set-primary`,
          { query },
        )
      return client.request('PATCH', `/calendar-connections/connections/${connectionId}`, {
        query,
        body: definedOnly(body),
      })
    },
  },
  {
    name: 'disconnect_calendar_connection',
    title: 'Disconnect a calendar',
    description:
      'Remove a calendar connection. The host stops getting conflict checks and event sync from it, so slots can be double booked. Confirm with the user first.',
    schema: {
      connectionId: z.string(),
      userId: z.string().optional().describe('Admin only: act for another user'),
    },
    readOnly: false,
    destructive: true,
    run: (client, { connectionId, userId }) =>
      client.request('DELETE', `/calendar-connections/connections/${connectionId}`, {
        query: definedOnly({ userId }),
      }),
  },
  {
    name: 'set_calendar_sync',
    title: 'Set the calendar sync provider',
    description:
      'Choose which connected calendar receives bookings for a user, or clear it (clear: true), which stops writing bookings to any calendar. Confirm first.',
    schema: {
      userId: z.string().describe('User to update; use get_me for your own id'),
      connectionId: z.string().optional().describe('Calendar connection id. Needed unless clear.'),
      provider: z.enum(SYNC_PROVIDERS).optional().describe('Provider of that connection. Needed unless clear.'),
      clear: z.boolean().optional(),
    },
    readOnly: false,
    destructive: true,
    run: (client, { userId, connectionId, provider, clear }) => {
      if (!clear) need(connectionId && provider, 'Pass connectionId and provider, or clear: true')
      return client.request('PATCH', `/user/${userId}/calendar-sync`, {
        body: {
          id: userId,
          calendarSyncProviders: clear ? null : { id: connectionId, type: provider },
        },
      })
    },
  },
]

// ---- Output schemas -------------------------------------------------------

const wrapped = (description: string, shape: z.ZodRawShape = {}) =>
  out(
    {
      items: list(record).describe('The results, when the API returns a plain list'),
      ...shape,
    },
    description,
  )

const done = (description: string) =>
  out({ ok: bool, id: str }, `${description} Response shape per API.`)

export const BOOKING_SETUP_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  list_meeting_type_templates: wrapped('Templates, one template, or the assigned meeting types/workspaces', {
    id: str,
    contactTags: list(z.string()),
    locations: list(z.string()),
    meetingInfo: any('Meeting settings of the template'),
    meetingOptions: any('Booking options of the template'),
  }),
  save_meeting_type_template: done('The created or updated template.'),
  assign_meeting_type_template: done('Result of the assignment.'),
  delete_meeting_type_template: done('Deletion result.'),
  list_queues: wrapped('Queues, one queue, or the next hosts', {
    id: str,
    type: str,
    meetingTypeId: str,
    workspaceId: str,
    userIds: list(z.string()),
    users: list(record),
    userGroups: list(record),
    userCapacities: list(record),
    groupId: str.describe('Set on next when the hosts come from a group'),
  }),
  update_queue: done('The updated queue.'),
  manage_queue_user_group: done('The created or updated group, or an empty success on delete.'),
  list_booking_links: wrapped('Booking links for the chosen scope', {
    link: str,
    meetingTypeId: str,
    personalLinks: list(record),
    workspaceLinks: list(record),
  }),
  save_group_booking_link: done('The created or updated group booking link.'),
  delete_group_booking_link: done('Deletion result.'),
  list_users: wrapped('Users, or one user', {
    users: list(record),
    total: num,
    count: num,
    offset: num,
    id: str,
    email: str,
  }),
  get_calendar_connection_options: wrapped('Calendars of a connection, or an OAuth URL', {
    authUrl: str.describe('Open this in a browser to connect the calendar'),
    provider: str,
    calendars: list(record),
  }),
  update_calendar_connection: done('The updated calendar connection.'),
  disconnect_calendar_connection: done('Deletion result.'),
  set_calendar_sync: done('The updated user or an empty success.'),
}
