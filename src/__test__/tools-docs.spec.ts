import { z } from 'zod/v3'
import type { MeetergoClient, RequestOptions } from '../client.js'
import { DOCS_OUTPUTS, DOCS_TOOLS } from '../tools-docs.js'

interface RecordedCall {
  method: string
  path: string
  options: RequestOptions
}

function record(response: unknown = {}) {
  const calls: RecordedCall[] = []
  const client = {
    request: (method: string, path: string, options: RequestOptions = {}) => {
      calls.push({ method, path, options })
      return Promise.resolve(response)
    },
  } as unknown as MeetergoClient
  return { client, calls }
}

async function callTool(name: string, args: Record<string, unknown>, response: unknown = {}) {
  const tool = DOCS_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  const { client, calls } = record(response)
  const result = await tool.run(client, args)
  return { call: calls[calls.length - 1], calls, result }
}

describe('docs and attachment wire format', () => {
  it('has an output schema for every tool', () => {
    expect(Object.keys(DOCS_OUTPUTS).sort()).toEqual(DOCS_TOOLS.map((t) => t.name).sort())
  })

  it('lists documents at the host root with only the supplied filters, and trims rows', async () => {
    const { call, result } = await callTool(
      'list_documents',
      { search: 'nis2', page: 2, favorites: true },
      {
        files: [
          {
            id: 'd1',
            originalFilename: 'NIS2',
            source: 'document',
            sizeBytes: 10,
            folderId: null,
            icon: 'x',
            parentDocumentId: null,
            hasChildren: true,
            isFavorite: false,
            createdAt: 'c',
            updatedAt: 'u',
          },
        ],
        page: 2,
        limit: 20,
        hasMore: false,
      },
    )
    expect(call.method).toBe('GET')
    expect(call.path).toBe('/documents')
    expect(call.options.root).toBe(true)
    expect(call.options.query).toEqual({ search: 'nis2', page: 2, favorites: true })
    expect(result).toEqual({
      files: [
        {
          id: 'd1',
          title: 'NIS2',
          kind: 'document',
          folderId: null,
          parentDocumentId: null,
          hasChildren: true,
          isFavorite: false,
          updatedAt: 'u',
        },
      ],
      page: 2,
      limit: 20,
      hasMore: false,
    })
  })

  it('lists subpages via parentId', async () => {
    const { call } = await callTool('list_documents', { parentId: 'p1' })
    expect(call.options.query).toEqual({ parentId: 'p1' })
  })

  it('gets a page as markdown by default and drops the editor JSON', async () => {
    const { call, result } = await callTool(
      'get_document',
      { documentId: 'd1' },
      { id: 'd1', kind: 'document', markdown: '# Hi', content: [{ type: 'p' }] },
    )
    expect(call.method).toBe('GET')
    expect(call.path).toBe('/documents/d1')
    expect(call.options.query).toEqual({ format: 'markdown' })
    expect(call.options.root).toBe(true)
    expect(result).toEqual({ id: 'd1', kind: 'document', markdown: '# Hi' })
  })

  it('keeps a spreadsheet workbook in markdown mode and sends no format for json', async () => {
    const sheet = { id: 's1', kind: 'spreadsheet', content: { sheets: {} } }
    const md = await callTool('get_document', { documentId: 's1' }, { ...sheet })
    expect(md.result).toEqual(sheet)
    const json = await callTool('get_document', { documentId: 'd1', format: 'json' }, {
      id: 'd1',
      content: [1],
    })
    expect(json.call.options.query).toEqual({})
    expect(json.result).toEqual({ id: 'd1', content: [1] })
  })

  it('creates a page with markdown and contact link', async () => {
    const { call } = await callTool('create_document', {
      kind: 'document',
      title: 'Notes',
      markdown: '# A',
      contactId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    })
    expect(call.method).toBe('POST')
    expect(call.path).toBe('/documents')
    expect(call.options.root).toBe(true)
    expect(call.options.body).toEqual({
      kind: 'document',
      title: 'Notes',
      markdown: '# A',
      contactId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    })
  })

  it('enforces spec limits on create and update schemas', () => {
    const create = DOCS_TOOLS.find((t) => t.name === 'create_document')!
    const update = DOCS_TOOLS.find((t) => t.name === 'update_document')!
    const c = z.object(create.schema)
    expect(c.safeParse({ kind: 'document', title: 'x'.repeat(201) }).success).toBe(false)
    expect(c.safeParse({ kind: 'page', title: 'x' }).success).toBe(false)
    expect(c.safeParse({ kind: 'document', title: 'x', markdown: 'm'.repeat(500_001) }).success).toBe(false)
    expect(c.safeParse({ kind: 'spreadsheet', title: 'x' }).success).toBe(true)
    const u = z.object(update.schema)
    expect(u.safeParse({ documentId: 'd', appendMarkdown: 'm'.repeat(500_001) }).success).toBe(false)
    expect(u.safeParse({ documentId: 'd', contactId: null, icon: null }).success).toBe(true)
  })

  it('appends markdown with a patch that contains only that field', async () => {
    const { call } = await callTool('update_document', { documentId: 'd1', appendMarkdown: 'more' })
    expect(call.method).toBe('PATCH')
    expect(call.path).toBe('/documents/d1')
    expect(call.options.root).toBe(true)
    expect(call.options.body).toEqual({ appendMarkdown: 'more' })
  })

  it('keeps explicit nulls (unlink, move to root) but drops unset fields', async () => {
    const { call } = await callTool('update_document', {
      documentId: 'd1',
      title: 'T',
      contactId: null,
      parentDocumentId: null,
    })
    expect(call.options.body).toEqual({ title: 'T', contactId: null, parentDocumentId: null })
  })

  it('rejects combined content fields and empty patches before any request', async () => {
    const tool = DOCS_TOOLS.find((t) => t.name === 'update_document')!
    const { client, calls } = record()
    await expect(
      tool.run(client, { documentId: 'd1', markdown: 'a', appendMarkdown: 'b' }),
    ).rejects.toThrow(/at most one/)
    await expect(tool.run(client, { documentId: 'd1' })).rejects.toThrow(/Nothing to change/)
    expect(calls).toHaveLength(0)
  })

  it('deletes a document, marked destructive', async () => {
    const { call } = await callTool('delete_document', { documentId: 'd1' })
    expect(call.method).toBe('DELETE')
    expect(call.path).toBe('/documents/d1')
    expect(call.options.root).toBe(true)
    const tool = DOCS_TOOLS.find((t) => t.name === 'delete_document')!
    expect(tool.destructive).toBe(true)
    expect(tool.readOnly).toBe(false)
  })

  it('fetches an attachment download link', async () => {
    const { call } = await callTool('get_attachment_download_url', { attachmentId: 'a1' })
    expect(call.method).toBe('GET')
    expect(call.path).toBe('/crm/attachments/a1/download')
    expect(call.options.root).toBe(true)
  })

  it('updates only the attachment description and deletes by id', async () => {
    const upd = await callTool('update_attachment', { attachmentId: 'a1', description: 'Vertrag' })
    expect(upd.call.method).toBe('PATCH')
    expect(upd.call.path).toBe('/crm/attachments/a1')
    expect(upd.call.options.body).toEqual({ description: 'Vertrag' })
    expect(upd.call.options.root).toBe(true)
    const del = await callTool('delete_attachment', { attachmentId: 'a1' })
    expect(del.call.method).toBe('DELETE')
    expect(del.call.path).toBe('/crm/attachments/a1')
    expect(del.call.options.root).toBe(true)
  })

  it('annotates reads and writes correctly', () => {
    const by = Object.fromEntries(DOCS_TOOLS.map((t) => [t.name, t]))
    for (const n of ['list_documents', 'get_document', 'get_attachment_download_url']) {
      expect(by[n].readOnly).toBe(true)
    }
    for (const n of ['create_document', 'update_document', 'update_attachment']) {
      expect(by[n].readOnly).toBe(false)
      expect(by[n].destructive).toBeUndefined()
    }
    expect(by.delete_attachment.destructive).toBe(true)
  })
})
