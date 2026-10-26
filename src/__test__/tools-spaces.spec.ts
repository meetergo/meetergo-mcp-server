import type { MeetergoClient, RequestOptions } from '../client.js'
import { SPACES_OUTPUTS, SPACES_TOOLS } from '../tools-spaces.js'

interface RecordedCall {
  method: string
  path: string
  options: RequestOptions
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<RecordedCall> {
  const tool = SPACES_TOOLS.find((t) => t.name === name)
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

describe('space tools', () => {
  it('has an output schema per tool and the right annotations', () => {
    expect(Object.keys(SPACES_OUTPUTS).sort()).toEqual(SPACES_TOOLS.map((t) => t.name).sort())
    const by = Object.fromEntries(SPACES_TOOLS.map((t) => [t.name, t]))
    expect(by.list_spaces.readOnly).toBe(true)
    expect(by.get_space.readOnly).toBe(true)
    for (const t of SPACES_TOOLS.filter((t) => t.name !== 'list_spaces' && t.name !== 'get_space')) {
      expect(t.readOnly, t.name).toBe(false)
    }
    expect(by.delete_space.destructive).toBe(true)
    // Outward-facing: publishing, share links, invites.
    for (const n of ['space_action', 'manage_space_link', 'manage_space_people']) {
      expect(by[n].openWorld, n).toBe(true)
    }
  })

  it('lists spaces, templates and section templates', async () => {
    expect(await callTool('list_spaces', {})).toMatchObject({ method: 'GET', path: '/space', options: { root: true } })
    expect(await callTool('list_spaces', { kind: 'templates' })).toMatchObject({ path: '/space/templates' })
    expect(await callTool('list_spaces', { kind: 'section_templates' })).toMatchObject({
      path: '/space-section-template',
    })
  })

  it('reads a space and its parts', async () => {
    expect(await callTool('get_space', { spaceId: 's1' })).toMatchObject({ method: 'GET', path: '/space/s1' })
    for (const [part, suffix] of [
      ['links', '/link'],
      ['form_status', '/form-status'],
      ['uploads', '/uploads'],
      ['people', '/people'],
    ]) {
      expect(await callTool('get_space', { spaceId: 's1', part })).toMatchObject({
        method: 'GET',
        path: `/space/s1${suffix}`,
        options: { root: true },
      })
    }
  })

  it('creates blank, from a template, and updates', async () => {
    const blank = await callTool('save_space', { name: 'Acme', internalNotes: 'n', settings: { showBranding: true } })
    expect(blank).toMatchObject({ method: 'POST', path: '/space', options: { root: true } })
    expect(blank.options.body).toEqual({ name: 'Acme', internalNotes: 'n', settings: { showBranding: true } })

    const tpl = await callTool('save_space', {
      sourceSpaceId: 'tpl-1',
      name: 'Acme portal',
      customerCompanyName: 'Acme GmbH',
      brandOverrides: { primaryColor: '#123456' },
    })
    expect(tpl).toMatchObject({ method: 'POST', path: '/space/from-template' })
    expect(tpl.options.body).toEqual({
      sourceSpaceId: 'tpl-1',
      name: 'Acme portal',
      customerCompanyName: 'Acme GmbH',
      brandOverrides: { primaryColor: '#123456' },
    })

    const upd = await callTool('save_space', { spaceId: 's1', name: 'New', sectionOrder: ['a', 'b'], description: null })
    expect(upd).toMatchObject({ method: 'PATCH', path: '/space/s1' })
    expect(upd.options.body).toEqual({ name: 'New', sectionOrder: ['a', 'b'], description: null })
  })

  it('refuses fields the chosen endpoint would drop', async () => {
    await expect(callTool('save_space', {})).rejects.toThrow(/name/)
    await expect(callTool('save_space', { sourceSpaceId: 't', settings: {} })).rejects.toThrow(/settings/)
    await expect(callTool('save_space', { spaceId: 's1', customerCompanyName: 'x' })).rejects.toThrow(
      /customerCompanyName/,
    )
    await expect(callTool('save_space', { spaceId: 's1', sourceSpaceId: 't' })).rejects.toThrow(/sourceSpaceId/)
  })

  it('deletes a space', async () => {
    expect(await callTool('delete_space', { spaceId: 's1' })).toMatchObject({
      method: 'DELETE',
      path: '/space/s1',
      options: { root: true },
    })
  })

  it('publishes, duplicates and saves as template', async () => {
    const pub = await callTool('space_action', { spaceId: 's1', action: 'publish' })
    expect(pub).toMatchObject({ method: 'POST', path: '/space/s1/publish' })
    expect(pub.options.body).toBeUndefined()
    const dup = await callTool('space_action', { spaceId: 's1', action: 'duplicate', name: 'Copy' })
    expect(dup).toMatchObject({ method: 'POST', path: '/space/s1/duplicate', options: { body: { name: 'Copy' } } })
    const tpl = await callTool('space_action', { spaceId: 's1', action: 'save_as_template' })
    expect(tpl).toMatchObject({ method: 'POST', path: '/space/s1/save-as-template', options: { body: {} } })
    await expect(callTool('space_action', { spaceId: 's1', action: 'publish', name: 'x' })).rejects.toThrow(/name/)
  })

  it('edits sections', async () => {
    const add = await callTool('edit_space_structure', {
      spaceId: 's1',
      action: 'add_section',
      section: { title: 'Onboarding', visibility: 'visible', index: 0 },
    })
    expect(add).toMatchObject({ method: 'POST', path: '/space/s1/section' })
    expect(add.options.body).toEqual({ title: 'Onboarding', visibility: 'visible', index: 0 })

    const fromTpl = await callTool('edit_space_structure', {
      spaceId: 's1',
      action: 'add_section_from_template',
      templateId: 't1',
      section: { index: 2 },
    })
    expect(fromTpl).toMatchObject({ method: 'POST', path: '/space/s1/section-from-template' })
    expect(fromTpl.options.body).toEqual({ templateId: 't1', index: 2 })

    const upd = await callTool('edit_space_structure', {
      spaceId: 's1',
      action: 'update_section',
      sectionId: 'sec1',
      section: { blockOrder: ['b2', 'b1'] },
    })
    expect(upd).toMatchObject({ method: 'PATCH', path: '/space/s1/section/sec1' })
    expect(upd.options.body).toEqual({ blockOrder: ['b2', 'b1'] })

    expect(
      await callTool('edit_space_structure', { spaceId: 's1', action: 'delete_section', sectionId: 'sec1' }),
    ).toMatchObject({ method: 'DELETE', path: '/space/s1/section/sec1', options: { root: true } })
    await expect(callTool('edit_space_structure', { spaceId: 's1', action: 'add_section' })).rejects.toThrow(/title/)
  })

  it('edits blocks', async () => {
    const add = await callTool('edit_space_structure', {
      spaceId: 's1',
      action: 'add_block',
      sectionId: 'sec1',
      block: { kind: 'text', title: 'Welcome', html: '<p>Hi</p>' },
    })
    expect(add).toMatchObject({ method: 'POST', path: '/space/s1/section/sec1/block' })
    expect(add.options.body).toEqual({ kind: 'text', title: 'Welcome', html: '<p>Hi</p>' })

    const upd = await callTool('edit_space_structure', {
      spaceId: 's1',
      action: 'update_block',
      sectionId: 'sec1',
      blockId: 'b1',
      block: { done: true },
    })
    expect(upd).toMatchObject({ method: 'PATCH', path: '/space/s1/section/sec1/block/b1' })
    expect(upd.options.body).toEqual({ done: true })

    expect(
      await callTool('edit_space_structure', {
        spaceId: 's1',
        action: 'delete_block',
        sectionId: 'sec1',
        blockId: 'b1',
      }),
    ).toMatchObject({ method: 'DELETE', path: '/space/s1/section/sec1/block/b1' })
    await expect(
      callTool('edit_space_structure', { spaceId: 's1', action: 'add_block', sectionId: 'sec1', block: { title: 'x' } }),
    ).rejects.toThrow(/kind/)
  })

  it('creates, updates and archives share links', async () => {
    const create = await callTool('manage_space_link', {
      spaceId: 's1',
      action: 'create',
      link: { name: 'Client', requireEmail: true, allowList: ['a@b.de'] },
    })
    expect(create).toMatchObject({ method: 'POST', path: '/space/s1/link' })
    expect(create.options.body).toEqual({ name: 'Client', requireEmail: true, allowList: ['a@b.de'] })
    const upd = await callTool('manage_space_link', {
      spaceId: 's1',
      action: 'update',
      linkId: 'l1',
      link: { expiresAt: null },
    })
    expect(upd).toMatchObject({ method: 'PATCH', path: '/space/s1/link/l1' })
    expect(upd.options.body).toEqual({ expiresAt: null })
    expect(await callTool('manage_space_link', { spaceId: 's1', action: 'archive', linkId: 'l1' })).toMatchObject({
      method: 'DELETE',
      path: '/space/s1/link/l1',
    })
    await expect(callTool('manage_space_link', { spaceId: 's1', action: 'create', link: {} })).rejects.toThrow(/name/)
  })

  it('invites and removes people', async () => {
    const inv = await callTool('manage_space_people', {
      spaceId: 's1',
      action: 'invite',
      email: 'a@b.de',
      name: 'A',
      sendEmail: false,
    })
    expect(inv).toMatchObject({ method: 'POST', path: '/space/s1/people' })
    expect(inv.options.body).toEqual({ email: 'a@b.de', name: 'A', sendEmail: false })
    expect(await callTool('manage_space_people', { spaceId: 's1', action: 'remove', inviteId: 'i1' })).toMatchObject({
      method: 'DELETE',
      path: '/space/s1/people/i1',
    })
    await expect(callTool('manage_space_people', { spaceId: 's1', action: 'invite' })).rejects.toThrow(/email/)
  })

  it('manages section templates', async () => {
    const structure = { title: 'Kickoff', blocks: [{ kind: 'text', title: 'Hi' }] }
    const create = await callTool('manage_space_section_template', { action: 'create', name: 'T', structure })
    expect(create).toMatchObject({ method: 'POST', path: '/space-section-template' })
    expect(create.options.body).toEqual({ name: 'T', structure })
    const snap = await callTool('manage_space_section_template', {
      action: 'from_section',
      spaceId: 's1',
      sectionId: 'sec1',
    })
    expect(snap).toMatchObject({ method: 'POST', path: '/space-section-template/from-section' })
    expect(snap.options.body).toEqual({ spaceId: 's1', sectionId: 'sec1' })
    expect(await callTool('manage_space_section_template', { action: 'delete', templateId: 't1' })).toMatchObject({
      method: 'DELETE',
      path: '/space-section-template/t1',
    })
  })
})
