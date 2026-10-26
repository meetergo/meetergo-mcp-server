/**
 * Spaces: shareable client portals (sections of blocks, share links, invited
 * people). Routes are `/space*` and `/space-section-template*` at the host
 * root, hence `root: true`.
 *
 * Consolidated on purpose: a space is edited through a handful of tools whose
 * `action` enum selects the endpoint. Reads and writes are never mixed, and
 * everything a client can see (publish, share links, invites) is `openWorld`.
 *
 * Not covered: GET /space/{id}/uploads/{uploadId}/download. Its spec entry has
 * no response body, and the client only parses JSON, so a binary or redirect
 * response would fail.
 */
import { z } from 'zod'
import { any, bool, list, num, out, str } from './output-helpers.js'
import { definedOnly } from './tool-helpers.js'
import type { ToolDefinition } from './tools.js'

const visibility = z.enum(['hidden', 'locked', 'visible'])
const itemStatus = z.enum(['todo', 'wip', 'done', 'cancelled'])
const blockKind = z.enum([
  'content',
  'task',
  'scheduler',
  'text',
  'form',
  'meetings',
  'team',
  'invitee',
  'embed',
  'upload',
  'html',
  'contact',
  'offer',
  'whiteboard',
])

const brandOverrides = z
  .object({
    logo: z.string().optional(),
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    backdropUrl: z.string().optional(),
    heroStyle: z.enum(['image', 'skyline', 'aurora']).optional(),
  })
  .describe("The client's look, applied over the defaults")

const block = z
  .object({
    kind: blockKind.optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    visibility: visibility.optional(),
    status: itemStatus.nullable().optional(),
    index: z.number().optional(),
    url: z.string().nullable().optional(),
    html: z.string().max(150000).nullable().optional(),
    text: z.record(z.unknown()).nullable().optional().describe('Rich-text document object'),
    formId: z.string().nullable().optional(),
    meetingTypeId: z.string().nullable().optional(),
    documentId: z.string().min(21).max(21).nullable().optional(),
    signatureRequestId: z.string().nullable().optional().describe('Own-company signature request (uuid)'),
    contentId: z.string().nullable().optional(),
    allowDownload: z.boolean().optional(),
    taskType: z.enum(['task', 'meeting', 'approval', 'documentRequest']).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    done: z.boolean().optional(),
    tasks: z
      .array(z.object({ id: z.string(), description: z.string(), done: z.boolean() }).passthrough())
      .max(200)
      .optional(),
    cta: z.object({ title: z.string(), url: z.string() }).nullable().optional(),
    resources: z
      .array(
        z.object({
          title: z.string(),
          url: z.string().optional(),
          contentId: z.string().optional(),
          folder: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough()
  .describe(
    'Block fields. kind and title are required when adding. Other API fields (internalOwnerId, ownerContactId, stakeholderIds, thumbnail) pass through.',
  )

const section = z
  .object({
    title: z.string().optional(),
    visibility: visibility.optional(),
    status: itemStatus.nullable().optional(),
    index: z.number().optional().describe('Position among the sections'),
    blockOrder: z.array(z.string()).optional().describe('update_section: block ids in the new order'),
  })
  .describe('Section fields. title is required when adding.')

const link = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
    expiresAt: z.string().nullable().optional(),
    requireEmail: z.boolean().optional(),
    requireEmailOtp: z.boolean().optional(),
    allowMagicLink: z.boolean().optional(),
    allowSmsOtp: z.boolean().optional(),
    password: z.string().nullable().optional(),
    allowList: z.array(z.string()).optional().describe('Emails or domains allowed in'),
    denyList: z.array(z.string()).optional(),
    allowDownload: z.boolean().optional(),
    allowUploads: z.boolean().optional(),
    allowViewerShare: z.boolean().optional(),
    enableWatermark: z.boolean().optional(),
    enableNda: z.boolean().optional(),
    enableScreenshotProtection: z.boolean().optional(),
    enableNotification: z.boolean().optional(),
    language: z
      .enum(['en', 'de', 'fr', 'es', 'no', 'nl', 'it', 'pl', 'se', 'tr', 'da'])
      .nullable()
      .optional(),
    isArchived: z.boolean().optional().describe('update only'),
  })
  .passthrough()
  .describe(
    'Link settings. name is required when creating. Other API fields (domainId, agreementId, watermarkConfig, customFields, audienceGroupId, permissionGroupId, ogTitle, ogDescription, ogImageUrl) pass through.',
  )

// Fields save_space may set, split by which endpoint accepts them.
const FROM_TEMPLATE_FIELDS = [
  'name',
  'description',
  'brandOverrides',
  'customerCompanyId',
  'customerCompanyName',
  'customerCompany',
  'crmCompanyId',
  'dealId',
]
const CREATE_FIELDS = [
  'name',
  'description',
  'slug',
  'ownerId',
  'customerCompanyId',
  'customerCompanyName',
  'customerCompany',
  'crmCompanyId',
  'dealId',
  'settings',
  'brandOverrides',
  'internalNotes',
]
const UPDATE_FIELDS = [
  'name',
  'description',
  'slug',
  'ownerId',
  'customerCompanyId',
  'customerCompany',
  'dealId',
  'settings',
  'brandOverrides',
  'internalNotes',
  'sectionOrder',
]

/** Picks the fields an endpoint accepts and refuses the rest, so nothing is silently dropped. */
function pickFields(
  args: Record<string, unknown>,
  allowed: string[],
  mode: string,
): Record<string, unknown> {
  const ignore = new Set(['spaceId', 'sourceSpaceId'])
  const bad = Object.keys(args).filter(
    (k) => args[k] !== undefined && !ignore.has(k) && !allowed.includes(k),
  )
  if (bad.length > 0) throw new Error(`${bad.join(', ')} not accepted when ${mode}`)
  return definedOnly(Object.fromEntries(allowed.map((k) => [k, args[k]])))
}

function need(args: Record<string, unknown>, keys: string[], what: string): void {
  const missing = keys.filter((k) => args[k] === undefined)
  if (missing.length > 0) throw new Error(`${what} needs ${missing.join(', ')}`)
}

export const SPACES_TOOLS: ToolDefinition[] = [
  {
    name: 'list_spaces',
    title: 'List spaces',
    description:
      'List client portals (kind "spaces"), reusable space templates ("templates"), or saved section templates ("section_templates").',
    schema: { kind: z.enum(['spaces', 'templates', 'section_templates']).default('spaces') },
    readOnly: true,
    run: (client, { kind }) =>
      client.request(
        'GET',
        kind === 'templates'
          ? '/space/templates'
          : kind === 'section_templates'
            ? '/space-section-template'
            : '/space',
        { root: true },
      ),
  },
  {
    name: 'get_space',
    title: 'Get a space',
    description:
      'Read one space with its sections and blocks, or via part: its share links, form submissions (form_status), files visitors uploaded (uploads), or invited people. File downloads are not available.',
    schema: {
      spaceId: z.string(),
      part: z
        .enum(['space', 'links', 'form_status', 'uploads', 'people'])
        .default('space'),
    },
    readOnly: true,
    run: (client, { spaceId, part }) => {
      const suffix: Record<string, string> = {
        links: '/link',
        form_status: '/form-status',
        uploads: '/uploads',
        people: '/people',
      }
      return client.request('GET', `/space/${spaceId}${suffix[part ?? 'space'] ?? ''}`, {
        root: true,
      })
    },
  },
  {
    name: 'save_space',
    title: 'Create or update a space',
    description:
      'Create a blank portal (name required), create one from a template or existing space (sourceSpaceId; copies sections and blocks and swaps in the client), or update one (spaceId; only supplied fields change). New spaces start as drafts: nothing is visible to the client until it is published.',
    schema: {
      spaceId: z.string().optional().describe('Set to update'),
      sourceSpaceId: z
        .string()
        .optional()
        .describe('Set to create from a template/space (see list_spaces kind templates)'),
      name: z.string().max(200).optional(),
      description: z.string().max(2000).nullable().optional(),
      slug: z.string().nullable().optional(),
      ownerId: z.string().nullable().optional(),
      customerCompanyId: z.string().nullable().optional().describe('Existing client company'),
      customerCompanyName: z
        .string()
        .max(200)
        .optional()
        .describe('Create only: create and link a client company by name'),
      customerCompany: z
        .record(z.unknown())
        .optional()
        .describe('Enrichment for a newly created client company (domain, logo, primaryColor, website, ...)'),
      crmCompanyId: z.string().nullable().optional().describe('Create only: link a CRM company'),
      dealId: z.string().nullable().optional(),
      settings: z
        .record(z.unknown())
        .optional()
        .describe('Space settings (contentModuleEnabled, showBranding, defaultItemAccess, welcome, team, tags, ...)'),
      brandOverrides: brandOverrides.optional(),
      internalNotes: z.string().nullable().optional(),
      sectionOrder: z.array(z.string()).optional().describe('Update only: section ids in the new order'),
    },
    readOnly: false,
    run: async (client, args) => {
      const { spaceId, sourceSpaceId } = args
      if (spaceId) {
        if (sourceSpaceId) throw new Error('sourceSpaceId is for creating; spaceId is for updating')
        return client.request('PATCH', `/space/${spaceId}`, {
          body: pickFields(args, UPDATE_FIELDS, 'updating a space'),
          root: true,
        })
      }
      if (sourceSpaceId) {
        return client.request('POST', '/space/from-template', {
          body: {
            sourceSpaceId,
            ...pickFields(args, FROM_TEMPLATE_FIELDS, 'creating from a template'),
          },
          root: true,
        })
      }
      need(args, ['name'], 'creating a blank space')
      return client.request('POST', '/space', {
        body: pickFields(args, CREATE_FIELDS, 'creating a space'),
        root: true,
      })
    },
  },
  {
    name: 'delete_space',
    title: 'Delete a space',
    description:
      'Delete a client portal, including its links. Confirm with the user first; visitors lose access immediately.',
    schema: { spaceId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { spaceId }) => client.request('DELETE', `/space/${spaceId}`, { root: true }),
  },
  {
    name: 'space_action',
    title: 'Publish, duplicate or save a space as template',
    description:
      'publish: make the portal live (visible to clients once a link or invite exists; confirm with the user first). duplicate: same-client copy, "(Copy)" suffixed by default. save_as_template: snapshot as a reusable template. name applies to the last two.',
    schema: {
      spaceId: z.string(),
      action: z.enum(['publish', 'duplicate', 'save_as_template']),
      name: z.string().max(200).optional().describe('Name of the copy/template'),
    },
    readOnly: false,
    openWorld: true,
    run: (client, { spaceId, action, name }) => {
      if (action === 'publish') {
        if (name !== undefined) throw new Error('name does not apply to publish')
        return client.request('POST', `/space/${spaceId}/publish`, { root: true })
      }
      const path = action === 'duplicate' ? 'duplicate' : 'save-as-template'
      return client.request('POST', `/space/${spaceId}/${path}`, {
        body: definedOnly({ name }),
        root: true,
      })
    },
  },
  {
    name: 'edit_space_structure',
    title: 'Edit space sections and blocks',
    description:
      'Change a space\'s layout. add_section / update_section / delete_section use `section` (and sectionId); add_section_from_template needs templateId (+ section.index); add_block / update_block / delete_block use `block` (sectionId, blockId). Edits to a published space are visible to clients immediately; deletes are permanent, confirm first.',
    schema: {
      spaceId: z.string(),
      action: z.enum([
        'add_section',
        'add_section_from_template',
        'update_section',
        'delete_section',
        'add_block',
        'update_block',
        'delete_block',
      ]),
      sectionId: z.string().optional().describe('All actions except add_section*'),
      blockId: z.string().optional().describe('update_block, delete_block'),
      templateId: z.string().optional().describe('add_section_from_template: section template id'),
      section: section.optional(),
      block: block.optional(),
    },
    readOnly: false,
    destructive: true,
    run: async (client, { spaceId, action, sectionId, blockId, templateId, section, block }) => {
      const base = `/space/${spaceId}`
      const sec = `${base}/section/${sectionId}`
      switch (action) {
        case 'add_section':
          need({ title: section?.title }, ['title'], 'add_section (section.title)')
          return client.request('POST', `${base}/section`, {
            body: definedOnly(section),
            root: true,
          })
        case 'add_section_from_template':
          need({ templateId }, ['templateId'], 'add_section_from_template')
          return client.request('POST', `${base}/section-from-template`, {
            body: definedOnly({ templateId, index: section?.index }),
            root: true,
          })
        case 'update_section':
          need({ sectionId, section }, ['sectionId', 'section'], 'update_section')
          return client.request('PATCH', sec, { body: definedOnly(section), root: true })
        case 'delete_section':
          need({ sectionId }, ['sectionId'], 'delete_section')
          return client.request('DELETE', sec, { root: true })
        case 'add_block':
          need({ sectionId, kind: block?.kind, title: block?.title }, ['sectionId', 'kind', 'title'], 'add_block (sectionId, block.kind, block.title)')
          return client.request('POST', `${sec}/block`, { body: definedOnly(block), root: true })
        case 'update_block':
          need({ sectionId, blockId, block }, ['sectionId', 'blockId', 'block'], 'update_block')
          return client.request('PATCH', `${sec}/block/${blockId}`, {
            body: definedOnly(block),
            root: true,
          })
        case 'delete_block':
          need({ sectionId, blockId }, ['sectionId', 'blockId'], 'delete_block')
          return client.request('DELETE', `${sec}/block/${blockId}`, { root: true })
        default:
          throw new Error(`unknown action ${String(action)}`)
      }
    },
  },
  {
    name: 'manage_space_link',
    title: 'Create, update or archive a space share link',
    description:
      'Share links are how clients open a portal. create (link.name required) makes a new outward-facing link, update changes its access rules (linkId), archive turns it off. Confirm access settings (email gate, password, downloads) with the user before creating or loosening a link.',
    schema: {
      spaceId: z.string(),
      action: z.enum(['create', 'update', 'archive']),
      linkId: z.string().optional().describe('update, archive'),
      link: link.optional().describe('create, update'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: async (client, { spaceId, action, linkId, link }) => {
      const base = `/space/${spaceId}/link`
      if (action === 'create') {
        need({ name: link?.name }, ['name'], 'create (link.name)')
        return client.request('POST', base, { body: definedOnly(link), root: true })
      }
      need({ linkId }, ['linkId'], action)
      if (action === 'archive') return client.request('DELETE', `${base}/${linkId}`, { root: true })
      need({ link }, ['link'], 'update')
      return client.request('PATCH', `${base}/${linkId}`, { body: definedOnly(link), root: true })
    },
  },
  {
    name: 'manage_space_people',
    title: 'Invite or remove people on a space',
    description:
      'invite: give a person access to a portal (sendEmail also mails them the link; confirm the address and whether to email first). remove: revoke an invite (inviteId, from the people list of the space).',
    schema: {
      spaceId: z.string(),
      action: z.enum(['invite', 'remove']),
      email: z.string().email().optional().describe('invite'),
      name: z.string().max(200).optional().describe('invite'),
      sendEmail: z.boolean().optional().describe('invite: email the portal link (best effort)'),
      inviteId: z.string().optional().describe('remove'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: async (client, { spaceId, action, email, name, sendEmail, inviteId }) => {
      if (action === 'invite') {
        need({ email }, ['email'], 'invite')
        return client.request('POST', `/space/${spaceId}/people`, {
          body: definedOnly({ email, name, sendEmail }),
          root: true,
        })
      }
      need({ inviteId }, ['inviteId'], 'remove')
      return client.request('DELETE', `/space/${spaceId}/people/${inviteId}`, { root: true })
    },
  },
  {
    name: 'manage_space_section_template',
    title: 'Create or delete a space section template',
    description:
      'create: a template from scratch (name + structure { title, blocks[] }). from_section: snapshot a live section (spaceId, sectionId; name defaults to the section title). delete: remove a template (templateId); spaces already built from it are unaffected.',
    schema: {
      action: z.enum(['create', 'from_section', 'delete']),
      name: z.string().max(200).optional(),
      structure: z
        .object({
          title: z.string().max(200),
          blocks: z.array(block).max(50).describe('Each block needs kind and title'),
        })
        .optional()
        .describe('create'),
      spaceId: z.string().optional().describe('from_section'),
      sectionId: z.string().optional().describe('from_section'),
      templateId: z.string().optional().describe('delete'),
    },
    readOnly: false,
    destructive: true,
    run: async (client, { action, name, structure, spaceId, sectionId, templateId }) => {
      if (action === 'create') {
        need({ name, structure }, ['name', 'structure'], 'create')
        return client.request('POST', '/space-section-template', {
          body: { name, structure },
          root: true,
        })
      }
      if (action === 'from_section') {
        need({ spaceId, sectionId }, ['spaceId', 'sectionId'], 'from_section')
        return client.request('POST', '/space-section-template/from-section', {
          body: definedOnly({ spaceId, sectionId, name }),
          root: true,
        })
      }
      need({ templateId }, ['templateId'], 'delete')
      return client.request('DELETE', `/space-section-template/${templateId}`, { root: true })
    },
  },
]

const spaceBlock = out(
  {
    id: str,
    kind: str,
    title: str,
    description: str,
    visibility: str,
    status: str,
    index: num,
  },
  'A block inside a section',
)

const spaceSection = out(
  {
    id: str,
    spaceId: str,
    title: str,
    visibility: str,
    status: str,
    index: num,
    blocks: list(spaceBlock),
    blockOrder: list(z.string()),
  },
  'A section of a space',
)

const spaceLink = out(
  {
    id: str,
    name: str,
    slug: str,
    expiresAt: str,
    requireEmail: bool,
    requireEmailOtp: bool,
    allowDownload: bool,
    allowUploads: bool,
    isArchived: bool,
  },
  'A share link of a space',
)

const space = out(
  {
    id: str,
    name: str,
    description: str,
    slug: str,
    status: str.describe('draft, published, closed or frozen'),
    ownerId: str,
    customerCompanyId: str,
    dealId: str,
    internalNotes: str,
    isFrozen: bool,
    createdAt: str,
    updatedAt: str,
    sectionOrder: list(z.string()),
    sections: list(spaceSection),
    links: list(spaceLink),
    customerCompany: any('Linked client company'),
    settings: any('Space settings'),
    brandOverrides: any('Client brand'),
  },
  'A space (client portal)',
)

const listOf = (item: z.ZodTypeAny, description: string) =>
  out({ items: list(item).describe('The results') }, description)

export const SPACES_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  list_spaces: listOf(space, 'Spaces, space templates or section templates, per kind'),
  // Shape depends on `part`: a space, or a list of links / uploads / people, or the form-status object.
  get_space: out(
    { ...space.shape, items: list(any('Entries of the chosen part')) },
    'A space, or the chosen part (links, form submissions, uploads, people; shape per API)',
  ),
  save_space: space,
  delete_space: out({ ok: bool }, 'Empty success'),
  space_action: space,
  edit_space_structure: out(
    { ...spaceSection.shape, ...spaceBlock.shape, ok: bool },
    'The section or block that was added or changed; empty on delete',
  ),
  manage_space_link: spaceLink,
  manage_space_people: out({ ok: bool }, 'Invite or removal result (response shape per API)'),
  manage_space_section_template: out(
    { id: str, name: str, structure: any('Template structure') },
    'The section template; empty on delete',
  ),
}
