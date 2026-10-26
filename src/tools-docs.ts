/**
 * meetergo Docs (pages and spreadsheets at /documents) and the CRM attachment
 * endpoints that need no upload step (rename/describe, delete, download link).
 *
 * Both live at the host root, not under /v4, hence `root: true`. Docs can hold
 * customer-related content, so every write says what it overwrites and the
 * delete says to confirm first.
 */
import { z } from 'zod'
import type { ToolDefinition } from './tools.js'
import { definedOnly } from './tool-helpers.js'
import { bool, list, num, out, record, str, any } from './output-helpers.js'

const MARKDOWN_MAX = 500_000

/** Spec: markdown, appendMarkdown and content must not be combined. */
const CONTENT_FIELDS = ['content', 'markdown', 'appendMarkdown'] as const

export const DOCS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_documents',
    title: 'List documents',
    description:
      'List pages and spreadsheets in meetergo Docs, compact rows without content (open a single document for that). Root pages by default; parentId lists the subpages of a page (hasChildren says which have any); search gives a flat list across all levels. Paginated with page; hasMore says whether another page exists.',
    schema: {
      search: z.string().optional(),
      parentId: z.string().optional().describe('List the subpages of this page'),
      folderId: z.string().optional().describe('Library folder'),
      favorites: z.boolean().optional().describe('Only the pages this user pinned'),
      page: z.number().int().min(1).optional(),
    },
    readOnly: true,
    run: async (client, args) => {
      const result = (await client.request('GET', '/documents', {
        query: definedOnly(args),
        root: true,
      })) as Record<string, unknown>
      if (!Array.isArray(result.files)) return result
      // Trim to what a model needs to pick a document; the row is otherwise
      // sizeBytes/icon/createdAt on every entry.
      return {
        ...result,
        files: result.files.map((f: Record<string, unknown>) => ({
          id: f.id,
          title: f.originalFilename,
          kind: f.source,
          folderId: f.folderId,
          parentDocumentId: f.parentDocumentId,
          hasChildren: f.hasChildren,
          isFavorite: f.isFavorite,
          updatedAt: f.updatedAt,
        })),
      }
    },
  },
  {
    name: 'get_document',
    title: 'Get a document',
    description:
      "Load one page or spreadsheet. For a page the default format 'markdown' returns the text as Markdown and leaves out the editor JSON (far fewer tokens); use 'json' only when you need the exact block structure. A spreadsheet always returns its workbook JSON in content.",
    schema: {
      documentId: z.string(),
      format: z.enum(['markdown', 'json']).optional().describe("Defaults to 'markdown'"),
    },
    readOnly: true,
    run: async (client, { documentId, format }) => {
      const wantMarkdown = format !== 'json'
      const doc = (await client.request('GET', `/documents/${documentId}`, {
        query: wantMarkdown ? { format: 'markdown' } : {},
        root: true,
      })) as Record<string, unknown>
      if (wantMarkdown && typeof doc.markdown === 'string') delete doc.content
      return doc
    },
  },
  {
    name: 'create_document',
    title: 'Create a document',
    description:
      "Create a page or spreadsheet in meetergo Docs. For a page, pass markdown to fill it in one call (headings, lists, checklists, quotes, code, tables, links). contactId links it to a CRM contact. Plans cap the number of documents (Free 1, Light 3); past the cap the API answers 403 PLAN_LIMIT_REACHED.",
    schema: {
      kind: z.enum(['document', 'spreadsheet']).describe("'document' is a page"),
      title: z.string().max(200),
      markdown: z.string().max(MARKDOWN_MAX).optional().describe('Pages only'),
      contactId: z.string().uuid().optional().describe('CRM contact the document is about'),
      folderId: z.string().optional(),
      parentDocumentId: z.string().optional().describe('Nest it under this page'),
    },
    readOnly: false,
    run: (client, args) =>
      client.request('POST', '/documents', { body: definedOnly(args), root: true }),
  },
  {
    name: 'update_document',
    title: 'Update a document',
    description:
      "Change a document; only supplied fields change. To add to a page use appendMarkdown (keeps everything else); markdown REPLACES the whole page and content replaces a page or spreadsheet with raw editor JSON, so confirm with the user before using either. Send at most one of markdown, appendMarkdown, content. contactId links a CRM contact (null unlinks); parentDocumentId moves the page (null = root). markdown, appendMarkdown and content are for pages only, except content on a spreadsheet.",
    schema: {
      documentId: z.string(),
      title: z.string().max(200).optional(),
      appendMarkdown: z.string().max(MARKDOWN_MAX).optional().describe('Added at the end of the page'),
      markdown: z.string().max(MARKDOWN_MAX).optional().describe('Replaces the whole page'),
      content: z
        .union([z.array(z.record(z.unknown())), z.record(z.unknown())])
        .optional()
        .describe('Full replacement: Plate blocks (page) or a Univer workbook (spreadsheet)'),
      contactId: z.string().uuid().nullable().optional(),
      parentDocumentId: z.string().nullable().optional(),
      icon: z.string().max(32).nullable().optional().describe('Emoji; null clears it'),
    },
    readOnly: false,
    run: async (client, { documentId, ...patch }) => {
      const body = definedOnly(patch)
      if (CONTENT_FIELDS.filter((k) => body[k] !== undefined).length > 1) {
        throw new Error('Send at most one of markdown, appendMarkdown and content.')
      }
      if (Object.keys(body).length === 0) {
        throw new Error('Nothing to change: pass at least one field besides documentId.')
      }
      return client.request('PATCH', `/documents/${documentId}`, { body, root: true })
    },
  },
  {
    name: 'delete_document',
    title: 'Delete a document',
    description:
      'Permanently delete a page or spreadsheet from meetergo Docs. Irreversible, and it may hold customer-related content: confirm with the user first and name the document.',
    schema: { documentId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { documentId }) =>
      client.request('DELETE', `/documents/${documentId}`, { root: true }),
  },

  // ---- CRM attachments (no upload: the API wants a fileAssetId that no ----
  // ---- documented endpoint produces, so create is deliberately absent) ----
  {
    name: 'get_attachment_download_url',
    title: 'Get an attachment download link',
    description:
      "Return a presigned url for a CRM attachment's file (attachment id from the attachment list). It works without credentials and expires after 7 days, so treat it as sensitive and fetch a fresh one rather than storing it. Link attachments have no file and answer 400.",
    schema: { attachmentId: z.string() },
    readOnly: true,
    run: (client, { attachmentId }) =>
      client.request('GET', `/crm/attachments/${attachmentId}/download`, { root: true }),
  },
  {
    name: 'update_attachment',
    title: 'Update an attachment',
    description:
      "Set the description/label of a CRM attachment. The API only allows changing the description, not the file name or the parent.",
    schema: { attachmentId: z.string(), description: z.string() },
    readOnly: false,
    run: (client, { attachmentId, description }) =>
      client.request('PATCH', `/crm/attachments/${attachmentId}`, {
        body: { description },
        root: true,
      }),
  },
  {
    name: 'delete_attachment',
    title: 'Delete an attachment',
    description:
      'Remove an attachment from a CRM company, deal or contact. Confirm with the user first.',
    schema: { attachmentId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { attachmentId }) =>
      client.request('DELETE', `/crm/attachments/${attachmentId}`, { root: true }),
  },
]

const documentRow = out(
  {
    id: str,
    title: str,
    kind: str.describe("'document' (page) or 'spreadsheet'"),
    folderId: str,
    parentDocumentId: str,
    hasChildren: bool.describe('Whether the page has subpages'),
    isFavorite: bool,
    updatedAt: str,
  },
  'A document without its content',
)

const documentSummary = out(
  {
    id: str,
    title: str,
    kind: str,
    parentDocumentId: str,
    contactId: str.describe('Linked CRM contact'),
  },
  'A document as returned by create',
)

const documentDetail = out(
  {
    id: str,
    title: str,
    kind: str,
    format: str.describe("'plate' for a page, 'univer' for a spreadsheet"),
    markdown: str.describe('Page text as Markdown, when format markdown was requested'),
    content: any('Plate blocks (page) or Univer workbook (spreadsheet); left out for pages in markdown mode'),
    parentDocumentId: str,
    contactId: str,
    contact: any('Linked contact {id, name}; name is null when the user may not see it'),
    ancestors: list(record).describe('Parent pages, root first'),
    icon: str,
    coverImage: str,
    kbEnabled: bool,
    updatedAt: str,
  },
  'A document with its content',
)

const done = out(
  { ok: bool.describe('true when the API returned an empty success') },
  'Empty success. Any fields present are what the API echoed back.',
)

export const DOCS_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  list_documents: out(
    {
      files: list(documentRow),
      page: num,
      limit: num,
      hasMore: bool,
    },
    'One page of documents',
  ),
  get_document: documentDetail,
  create_document: documentSummary,
  update_document: done,
  delete_document: done,
  get_attachment_download_url: out(
    { url: str.describe('Presigned download URL, valid for 7 days') },
    'Download link for the attachment file',
  ),
  update_attachment: out(
    {
      id: str,
      kind: str.describe("'file' or 'link'"),
      description: str,
      filename: str,
      mimeType: str,
      sizeBytes: num,
      dealId: str,
      contactId: str,
      crmCompanyId: str,
    },
    'The updated attachment',
  ),
  delete_attachment: done,
}
