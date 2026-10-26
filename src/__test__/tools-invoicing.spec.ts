import type { MeetergoClient, RequestOptions } from '../client.js'
import { INVOICING_TOOLS } from '../tools-invoicing.js'

interface RecordedCall {
  method: string
  path: string
  options: RequestOptions
}

/** Records what a tool would put on the wire, same harness idea as tools.spec.ts. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<RecordedCall[]> {
  const tool = INVOICING_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  const calls: RecordedCall[] = []
  const client = {
    request: (method: string, path: string, options: RequestOptions = {}) => {
      calls.push({ method, path, options })
      return Promise.resolve({})
    },
  } as unknown as MeetergoClient
  await tool.run(client, args)
  return calls
}

async function one(name: string, args: Record<string, unknown> = {}): Promise<RecordedCall> {
  const calls = await callTool(name, args)
  expect(calls).toHaveLength(1)
  expect(calls[0].options.root).toBe(true)
  return calls[0]
}

const buyer = { name: 'Acme GmbH', email: 'a@acme.test' }

describe('invoicing tool annotations', () => {
  const tool = (name: string) => INVOICING_TOOLS.find((t) => t.name === name)!

  it('keeps reads read-only and every mutation a write', () => {
    for (const name of [
      'list_sales_documents',
      'get_sales_document',
      'get_invoicing_config',
      'get_invoice_buyer_prefill',
    ]) {
      expect(tool(name).readOnly).toBe(true)
      expect(tool(name).destructive).toBeUndefined()
    }
    for (const t of INVOICING_TOOLS.filter((x) => !x.readOnly)) expect(t.readOnly).toBe(false)
  })

  it('marks everything irreversible or customer-facing', () => {
    for (const name of ['send_sales_document', 'update_invoicing_config']) {
      expect(tool(name).openWorld).toBe(true)
    }
    for (const name of [
      'send_sales_document',
      'change_sales_document_status',
      'manage_document_payment',
      'delete_sales_document_draft',
      'update_invoicing_config',
    ]) {
      expect(tool(name).destructive).toBe(true)
    }
    expect(tool('save_sales_document_draft').destructive).toBeUndefined()
    expect(tool('manage_sales_document').destructive).toBeUndefined()
    expect(tool('manage_sales_document').openWorld).toBeUndefined()
  })
})

describe('invoicing wire format: reads', () => {
  it('lists documents with page/limit and a comma-joined kinds filter', async () => {
    const c = await one('list_sales_documents', {
      kinds: ['invoice', 'credit_note'],
      status: 'paid',
      search: 'Acme',
      page: 2,
      limit: 10,
    })
    expect(c).toMatchObject({ method: 'GET', path: '/invoicing/documents' })
    expect(c.options.query).toEqual({
      kinds: 'invoice,credit_note',
      status: 'paid',
      search: 'Acme',
      page: 2,
      limit: 10,
    })
  })

  it('passes a single kind through as kind', async () => {
    const c = await one('list_sales_documents', { kind: 'offer' })
    expect(c.options.query).toEqual({ kind: 'offer' })
  })

  it('fetches a document and each related view from the right path', async () => {
    const base = '/invoicing/documents/d-1'
    expect(await one('get_sales_document', { documentId: 'd-1' })).toMatchObject({ method: 'GET', path: base })
    const views: Record<string, string> = {
      events: '/events',
      payments: '/payments',
      credit_summary: '/credit-notes',
      payment_link: '/payment-link',
      dunning_preview: '/dunning/preview',
    }
    for (const [view, suffix] of Object.entries(views)) {
      expect(await one('get_sales_document', { documentId: 'd-1', view })).toMatchObject({
        method: 'GET',
        path: base + suffix,
      })
    }
  })

  it('reads config by kind, one record by id for products and recurring', async () => {
    expect((await one('get_invoicing_config', { kind: 'settings' })).path).toBe('/invoicing/settings')
    expect((await one('get_invoicing_config', { kind: 'bank_accounts' })).path).toBe('/invoicing/bank-accounts')
    expect((await one('get_invoicing_config', { kind: 'number_ranges' })).path).toBe('/invoicing/number-ranges')
    expect((await one('get_invoicing_config', { kind: 'products' })).path).toBe('/invoicing/products')
    expect((await one('get_invoicing_config', { kind: 'products', id: 'p-1' })).path).toBe('/invoicing/products/p-1')
    expect((await one('get_invoicing_config', { kind: 'recurring', id: 'r-1' })).path).toBe('/invoicing/recurring/r-1')
    await expect(callTool('get_invoicing_config', { kind: 'settings', id: 'x' })).rejects.toThrow(/id is only/)
  })

  it('prefills the buyer, listing contacts when no contactId is given', async () => {
    const withContact = await one('get_invoice_buyer_prefill', { crmCompanyId: 'co-1', contactId: 'ct-1' })
    expect(withContact).toMatchObject({ method: 'GET', path: '/invoicing/buyer-prefill/company/co-1' })
    expect(withContact.options.query).toEqual({ contactId: 'ct-1' })
    const contacts = await one('get_invoice_buyer_prefill', { crmCompanyId: 'co-1' })
    expect(contacts.path).toBe('/invoicing/buyer-prefill/company/co-1/contacts')
  })
})

describe('invoicing wire format: drafts', () => {
  it('creates a draft with the buyer and lines, without sending documentId', async () => {
    const lines = [{ name: 'Beratung', quantity: 2, unitPrice: 150, taxRate: 19, unitCode: 'HUR' }]
    const c = await one('save_sales_document_draft', {
      kind: 'invoice',
      buyer,
      lines,
      currency: 'EUR',
      dueDate: '2026-11-30',
    })
    expect(c).toMatchObject({ method: 'POST', path: '/invoicing/documents' })
    expect(c.options.body).toEqual({ kind: 'invoice', buyer, lines, currency: 'EUR', dueDate: '2026-11-30' })
  })

  it('requires a buyer on create', async () => {
    await expect(callTool('save_sales_document_draft', { kind: 'offer' })).rejects.toThrow(/buyer is required/)
  })

  it('patches an existing draft with only the changed fields, and null clears', async () => {
    const c = await one('save_sales_document_draft', { documentId: 'd-1', subject: null, dueDate: '2026-12-01' })
    expect(c).toMatchObject({ method: 'PATCH', path: '/invoicing/documents/d-1' })
    expect(c.options.body).toEqual({ subject: null, dueDate: '2026-12-01' })
  })

  it('refuses create-only fields on update', async () => {
    await expect(
      callTool('save_sales_document_draft', { documentId: 'd-1', kind: 'offer' }),
    ).rejects.toThrow(/only be set when creating/)
  })

  it('deletes a draft', async () => {
    expect(await one('delete_sales_document_draft', { documentId: 'd-1' })).toMatchObject({
      method: 'DELETE',
      path: '/invoicing/documents/d-1',
    })
  })
})

describe('invoicing wire format: document actions', () => {
  it('duplicates and converts without a body', async () => {
    const dup = await one('manage_sales_document', { documentId: 'd-1', action: 'duplicate' })
    expect(dup).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/duplicate' })
    expect(dup.options.body).toBeUndefined()
    const conv = await one('manage_sales_document', { documentId: 'd-1', action: 'convert_to_invoice' })
    expect(conv).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/convert-to-invoice' })
  })

  it('creates a credit-note draft with reason and optional line ids', async () => {
    const lineId = '11111111-1111-4111-8111-111111111111'
    const c = await one('manage_sales_document', {
      documentId: 'd-1',
      action: 'create_credit_note',
      reason: 'Falsche Menge',
      lineIds: [lineId],
    })
    expect(c).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/credit-note' })
    expect(c.options.body).toEqual({ reason: 'Falsche Menge', lineIds: [lineId] })
    const all = await one('manage_sales_document', {
      documentId: 'd-1',
      action: 'create_credit_note',
      reason: 'x',
      lineIds: [],
    })
    expect(all.options.body).toEqual({ reason: 'x' })
    await expect(
      callTool('manage_sales_document', { documentId: 'd-1', action: 'create_credit_note' }),
    ).rejects.toThrow(/reason is required/)
  })

  it('pauses dunning, including paused=false', async () => {
    const c = await one('manage_sales_document', { documentId: 'd-1', action: 'dunning_pause', paused: false })
    expect(c).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/dunning-pause' })
    expect(c.options.body).toEqual({ paused: false })
    await expect(
      callTool('manage_sales_document', { documentId: 'd-1', action: 'dunning_pause' }),
    ).rejects.toThrow(/paused/)
  })

  it('sends by email, WhatsApp and dunning on separate endpoints', async () => {
    const mail = await one('send_sales_document', {
      documentId: 'd-1',
      channel: 'email',
      to: 'x@acme.test',
      includePaymentLink: false,
    })
    expect(mail).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/send' })
    expect(mail.options.body).toEqual({ to: 'x@acme.test', includePaymentLink: false })

    const wa = await one('send_sales_document', {
      documentId: 'd-1',
      channel: 'whatsapp',
      phoneNumberId: 'wa-1',
      phone: '+4915112345678',
    })
    expect(wa).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/send-whatsapp' })
    expect(wa.options.body).toEqual({ phoneNumberId: 'wa-1', phone: '+4915112345678' })

    const dun = await one('send_sales_document', { documentId: 'd-1', channel: 'dunning_reminder' })
    expect(dun).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/dunning/send' })
    expect(dun.options.body).toEqual({})
  })

  it('finalizes, cancels, issues credit notes and sets the offer status', async () => {
    const fin = await one('change_sales_document_status', {
      documentId: 'd-1',
      action: 'finalize',
      profile: 'xrechnung-cii',
    })
    expect(fin).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/finalize' })
    expect(fin.options.body).toEqual({ profile: 'xrechnung-cii' })
    expect((await one('change_sales_document_status', { documentId: 'd-1', action: 'finalize' })).options.body).toEqual({})

    const cancel = await one('change_sales_document_status', { documentId: 'd-1', action: 'cancel' })
    expect(cancel).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/cancel' })
    expect(cancel.options.body).toBeUndefined()

    const issue = await one('change_sales_document_status', { documentId: 'cn-1', action: 'issue_credit_note' })
    expect(issue).toMatchObject({ method: 'POST', path: '/invoicing/credit-notes/cn-1/issue' })

    const accepted = await one('change_sales_document_status', { documentId: 'o-1', action: 'accept_offer' })
    expect(accepted).toMatchObject({ method: 'POST', path: '/invoicing/documents/o-1/offer-status' })
    expect(accepted.options.body).toEqual({ status: 'accepted' })
    const rejected = await one('change_sales_document_status', { documentId: 'o-1', action: 'reject_offer' })
    expect(rejected.options.body).toEqual({ status: 'rejected' })
  })

  it('records and deletes payments', async () => {
    const rec = await one('manage_document_payment', {
      documentId: 'd-1',
      action: 'record',
      amount: 5000,
      method: 'bank_transfer',
      paidAt: '2026-10-20',
      note: 'Zahlung Oktober',
    })
    expect(rec).toMatchObject({ method: 'POST', path: '/invoicing/documents/d-1/payments' })
    expect(rec.options.body).toEqual({
      amount: 5000,
      method: 'bank_transfer',
      paidAt: '2026-10-20',
      note: 'Zahlung Oktober',
    })
    await expect(
      callTool('manage_document_payment', { documentId: 'd-1', action: 'record', amount: 1 }),
    ).rejects.toThrow(/amount and method/)

    const del = await one('manage_document_payment', { documentId: 'd-1', action: 'delete', paymentId: 'pay-1' })
    expect(del).toMatchObject({ method: 'DELETE', path: '/invoicing/documents/d-1/payments/pay-1' })
    await expect(callTool('manage_document_payment', { documentId: 'd-1', action: 'delete' })).rejects.toThrow(
      /paymentId/,
    )
  })
})

describe('invoicing wire format: setup writes', () => {
  it('creates, updates and deletes products', async () => {
    const created = await one('update_invoicing_config', {
      kind: 'product',
      op: 'create',
      data: { name: 'Beratung', unitPrice: 150, unitCode: 'HUR', taxRate: 19, kind: 'service' },
    })
    expect(created).toMatchObject({ method: 'POST', path: '/invoicing/products' })
    expect(created.options.body).toEqual({
      name: 'Beratung',
      unitPrice: 150,
      unitCode: 'HUR',
      taxRate: 19,
      kind: 'service',
    })
    const updated = await one('update_invoicing_config', {
      kind: 'product',
      op: 'update',
      id: 'p-1',
      data: { unitPrice: 160 },
    })
    expect(updated).toMatchObject({ method: 'PATCH', path: '/invoicing/products/p-1' })
    expect(updated.options.body).toEqual({ unitPrice: 160 })
    expect(await one('update_invoicing_config', { kind: 'product', op: 'delete', id: 'p-1' })).toMatchObject({
      method: 'DELETE',
      path: '/invoicing/products/p-1',
    })
  })

  it('manages bank accounts', async () => {
    const created = await one('update_invoicing_config', {
      kind: 'bank_account',
      op: 'create',
      data: { label: 'Hauptkonto', iban: 'DE02120300000000202051', isDefault: true },
    })
    expect(created).toMatchObject({ method: 'POST', path: '/invoicing/bank-accounts' })
    const updated = await one('update_invoicing_config', {
      kind: 'bank_account',
      op: 'update',
      id: 'b-1',
      data: { bic: null },
    })
    expect(updated).toMatchObject({ method: 'PATCH', path: '/invoicing/bank-accounts/b-1' })
    expect(updated.options.body).toEqual({ bic: null })
    expect((await one('update_invoicing_config', { kind: 'bank_account', op: 'delete', id: 'b-1' })).method).toBe(
      'DELETE',
    )
  })

  it('puts settings and number ranges', async () => {
    const settings = await one('update_invoicing_config', {
      kind: 'settings',
      op: 'update',
      data: { smallBusiness: false, defaultTaxRate: 19, defaultPaymentTermDays: 14 },
    })
    expect(settings).toMatchObject({ method: 'PUT', path: '/invoicing/settings' })
    expect(settings.options.body).toEqual({ smallBusiness: false, defaultTaxRate: 19, defaultPaymentTermDays: 14 })

    const range = await one('update_invoicing_config', {
      kind: 'number_range',
      op: 'update',
      id: 'invoice',
      data: { format: 'RE-{YYYY}-{####}', nextCounter: 100 },
    })
    expect(range).toMatchObject({ method: 'PUT', path: '/invoicing/number-ranges/invoice' })
    expect(range.options.body).toEqual({ format: 'RE-{YYYY}-{####}', nextCounter: 100 })
  })

  it('manages recurring invoices with a full template', async () => {
    const template = { buyer, lines: [{ name: 'Retainer', quantity: 1, unitPrice: 990 }] }
    const created = await one('update_invoicing_config', {
      kind: 'recurring',
      op: 'create',
      data: { name: 'Retainer Acme', template, interval: 'monthly', nextRunAt: '2026-11-01', autoFinalize: true },
    })
    expect(created).toMatchObject({ method: 'POST', path: '/invoicing/recurring' })
    expect(created.options.body).toEqual({
      name: 'Retainer Acme',
      template,
      interval: 'monthly',
      nextRunAt: '2026-11-01',
      autoFinalize: true,
    })
    const updated = await one('update_invoicing_config', {
      kind: 'recurring',
      op: 'update',
      id: 'r-1',
      data: { active: false, endDate: null },
    })
    expect(updated).toMatchObject({ method: 'PATCH', path: '/invoicing/recurring/r-1' })
    expect(updated.options.body).toEqual({ active: false, endDate: null })
    expect((await one('update_invoicing_config', { kind: 'recurring', op: 'delete', id: 'r-1' })).method).toBe(
      'DELETE',
    )
  })

  it('rejects bad payloads before anything is sent', async () => {
    const bad = (args: Record<string, unknown>) => callTool('update_invoicing_config', args)
    await expect(bad({ kind: 'product', op: 'create', data: { name: 'x' } })).rejects.toThrow(/unitPrice/)
    await expect(bad({ kind: 'product', op: 'create', data: { name: 'x', unitPrice: 1, bogus: 1 } })).rejects.toThrow(
      /Invalid data/,
    )
    await expect(bad({ kind: 'product', op: 'update', data: { unitPrice: 1 } })).rejects.toThrow(/id is required/)
    await expect(bad({ kind: 'settings', op: 'create', data: {} })).rejects.toThrow(/only supports op update/)
    await expect(bad({ kind: 'number_range', op: 'update', data: {} })).rejects.toThrow(/id/)
    await expect(
      bad({ kind: 'recurring', op: 'create', data: { name: 'x', interval: 'monthly', nextRunAt: '2026-11-01', template: {} } }),
    ).rejects.toThrow(/Invalid data/)
  })
})
