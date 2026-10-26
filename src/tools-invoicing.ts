import { z } from 'zod/v3'
import type { ToolDefinition } from './tools.js'
import { definedOnly } from './tool-helpers.js'
import { any, bool, list, numOrStr, out, record, str } from './output-helpers.js'

/**
 * Invoicing (/invoicing/*, host root, not under /v4).
 *
 * Split by risk, not by endpoint. Reads are two tools plus a buyer helper;
 * drafts are freely editable; everything that cannot be taken back or that
 * reaches a customer sits in its own tool so a host confirms it as a distinct
 * step: send_sales_document (mail/WhatsApp/dunning), change_sales_document_status
 * (finalize assigns a legally binding number, cancel, issue credit note) and
 * manage_document_payment.
 *
 * Money: the spec states units only for product prices ("net unit price, 4
 * decimal places", i.e. major currency units such as 99.50) and percentages
 * (19 = 19 %). Payment amounts have no stated unit. Every amount is passed
 * through unchanged and descriptions say so; do not convert here.
 *
 * Not exposed: PDF/XML download, document preview and DATEV export (binary or
 * unspecified responses; the client only reads JSON), DATEV send and billing
 * runs (the spec defines empty request bodies, so the wire shape is unknown).
 */

const enc = encodeURIComponent
const BASE = '/invoicing'

const DOCUMENT_KINDS = ['offer', 'order_confirmation', 'invoice', 'credit_note', 'cancellation'] as const
const DOCUMENT_STATUSES = [
  'draft',
  'finalized',
  'sent',
  'partially_paid',
  'paid',
  'cancelled',
  'accepted',
  'rejected',
] as const
const TAX_CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const
const TAX_TREATMENTS = [
  'standard',
  'tax_free_de',
  'reverse_charge_13b',
  'reverse_charge_18b',
  'intra_community',
  'oss',
  'export',
  'out_of_scope',
] as const
const INTERVALS = ['weekly', 'monthly', 'quarterly', 'semiannually', 'yearly'] as const

const isoDate = (what: string) => z.string().describe(`${what}, ISO date YYYY-MM-DD`)
const taxCategory = z
  .enum(TAX_CATEGORIES)
  .describe('EN 16931 VAT category: S standard, Z zero, E exempt, AE reverse charge, K intra-community, G export, O out of scope')

const buyerShape = {
  name: z.string().max(255),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  postalCode: z.string().max(16).optional(),
  city: z.string().max(120).optional(),
  countryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2, default DE'),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional().describe('E.164, needed for WhatsApp delivery'),
  vatId: z.string().max(32).optional(),
  reference: z.string().max(64).optional().describe('Buyer reference (BT-10), Leitweg-ID for public bodies'),
}

const lineShape = {
  name: z.string().max(255),
  quantity: z.number(),
  unitPrice: z.number().describe('Net price per unit in major currency units (99.5 = 99.50), up to 4 decimals'),
  discountPercent: z.number().min(0).max(100).optional().describe('Percent, 10 = 10 %. Default 0'),
  taxCategory: taxCategory.optional(),
  taxRate: z.number().min(0).max(100).optional().describe('VAT percent, 19 = 19 %'),
  unit: z.string().max(32).nullable().optional().describe('Display unit, e.g. "Std."'),
  unitCode: z.string().max(8).optional().describe('UN/ECE Rec. 20 code, default C62 (piece); HUR = hour'),
  description: z.string().nullable().optional().describe('Plain text'),
  productId: z.string().uuid().optional().describe('Catalog product the line comes from'),
}

/** Draft fields shared by create, update and the recurring template. */
const nullableText = (what: string) => z.string().nullable().optional().describe(`${what}; null clears it`)
const draftShape = {
  language: z.enum(['de', 'en']).optional().describe('Document language, defaults to the seller setting'),
  issueDate: isoDate('Issue date, defaults to today').optional(),
  deliveryDate: isoDate('Delivery/service date (period start)').nullable().optional(),
  deliveryDateEnd: isoDate('Service period end').nullable().optional(),
  dueDate: isoDate('Due date').nullable().optional(),
  subject: z.string().max(255).nullable().optional().describe('Subject line, also the mail subject; null clears it'),
  headText: nullableText('Text above the lines'),
  footText: nullableText('Text below the totals'),
  note: nullableText('Free-text note'),
  paymentTermsNote: nullableText('Payment terms note'),
  deliveryTermsNote: nullableText('Delivery terms note'),
  currency: z.string().length(3).optional().describe('ISO 4217, default EUR'),
  buyer: z.object(buyerShape).optional().describe('Required when creating'),
  lines: z.array(z.object(lineShape)).optional().describe('On update this REPLACES the whole line list'),
  taxTreatment: z.enum(TAX_TREATMENTS).optional(),
  skontoPercent: z.number().min(0.01).max(100).nullable().optional().describe('Early-payment discount percent'),
  skontoDays: z.number().min(1).max(365).nullable().optional().describe('Days the Skonto applies'),
  totalDiscountPercent: z.number().min(0).max(100).nullable().optional().describe('Document-level discount percent'),
  internalContactUserId: z.string().nullable().optional().describe('meetergo user shown as seller contact'),
  depositPercent: z.number().min(0.01).max(100).nullable().optional().describe('Deposit percent, offers only'),
  contactId: z.string().uuid().optional().describe('CRM contact'),
  dealId: z.string().uuid().optional().describe('CRM deal'),
}

/** The recurring template is a full create payload, so the buyer is required inside it. */
const templateSchema = z
  .object({
    ...draftShape,
    kind: z.enum(DOCUMENT_KINDS).optional(),
    buyer: z.object(buyerShape),
  })
  .strict()

const productFields = {
  name: z.string().max(255),
  description: z.string().nullable().optional(),
  descriptionHtml: z.string().max(20000).nullable().optional(),
  articleNumber: z.string().max(64).nullable().optional(),
  kind: z.enum(['service', 'good']).optional(),
  unit: z.string().max(32).nullable().optional(),
  unitCode: z.string().max(8).optional(),
  unitPrice: z.number(),
  currency: z.string().length(3).optional(),
  taxCategory: z.enum(TAX_CATEGORIES).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  excludedFromSmallBusiness: z.boolean().optional(),
  meetingTypeId: z.string().uuid().optional(),
  active: z.boolean().optional(),
}

const bankFields = {
  label: z.string().max(120),
  iban: z.string().max(34),
  bic: z.string().max(11).nullable().optional(),
  bankName: z.string().max(255).nullable().optional(),
  currency: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
}

const looseObject = z.record(z.string(), z.unknown())
const settingsFields = {
  legalName: z.string().nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  postalCode: z.string().max(16).nullable().optional(),
  city: z.string().nullable().optional(),
  countryCode: z.string().length(2).optional(),
  taxNumber: z.string().nullable().optional(),
  vatId: z.string().nullable().optional(),
  smallBusiness: z.boolean().optional(),
  defaultTaxRate: z.number().min(0).max(100).optional(),
  defaultPaymentTermDays: z.number().min(0).max(365).optional(),
  taxExemptionNotes: z.record(z.string(), z.string()).nullable().optional(),
  iban: z.string().max(34).nullable().optional(),
  bic: z.string().max(11).nullable().optional(),
  bankName: z.string().max(120).nullable().optional(),
  contactEmail: z.string().max(255).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  website: z.string().max(255).nullable().optional(),
  registerInfo: z.string().max(255).nullable().optional(),
  managingDirector: z.string().max(255).nullable().optional(),
  logoFileAssetId: z.string().uuid().nullable().optional(),
  dunning: looseObject.nullable().optional(),
  autoInvoice: looseObject.nullable().optional(),
  datev: looseObject.nullable().optional(),
  offerAutomation: looseObject.nullable().optional(),
  layout: looseObject.nullable().optional(),
  documentMail: looseObject.nullable().optional(),
  defaultHeadText: z.string().max(5000).nullable().optional(),
  defaultFootText: z.string().max(5000).nullable().optional(),
  documentLanguage: z.enum(['de', 'en']).nullable().optional(),
}

const recurringFields = {
  name: z.string().max(255),
  template: templateSchema,
  interval: z.enum(INTERVALS),
  nextRunAt: z.string(),
  autoFinalize: z.boolean().optional(),
  autoSend: z.boolean().optional(),
}

const productCreate = z.object(productFields).strict()
const productUpdate = z.object(productFields).partial().strict()
const bankCreate = z.object(bankFields).strict()
const bankUpdate = z.object(bankFields).partial().strict()
const settingsUpdate = z.object(settingsFields).strict()
const numberRangeUpdate = z
  .object({ format: z.string().optional(), nextCounter: z.number().int().min(0).optional() })
  .strict()
const recurringCreate = z.object({ ...recurringFields, endDate: z.string().optional() }).strict()
const recurringUpdate = z
  .object({
    ...recurringFields,
    endDate: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .partial()
  .strict()

/** Reports a bad `data` payload in words the model can act on, before anything is sent. */
function parseData<T extends z.ZodTypeAny>(schema: T, data: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(data ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'data'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid data for ${what}: ${detail}`)
  }
  return parsed.data
}

function need(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const documentPath = (id: string, suffix = '') => `${BASE}/documents/${enc(id)}${suffix}`

const CONFIG_READS = {
  settings: `${BASE}/settings`,
  products: `${BASE}/products`,
  bank_accounts: `${BASE}/bank-accounts`,
  number_ranges: `${BASE}/number-ranges`,
  recurring: `${BASE}/recurring`,
} as const
/** The kinds whose single record can be fetched by id. */
const CONFIG_READS_WITH_ID = new Set(['products', 'recurring'])

const CONFIRM =
  'Irreversible: show the user the exact document (number or id, buyer, total) and get an explicit yes first.'

export const INVOICING_TOOLS: ToolDefinition[] = [
  // ---- Documents: reads -------------------------------------------------
  {
    name: 'list_sales_documents',
    title: 'List invoices and offers',
    description:
      'List invoicing documents (offers, order confirmations, invoices, credit notes, cancellations), filterable by kind, status and free-text search. Paginated with page (from 1) and limit (max 50, default 25).',
    schema: {
      kind: z.enum(DOCUMENT_KINDS).optional(),
      kinds: z.array(z.enum(DOCUMENT_KINDS)).optional().describe('Several kinds at once; overrides kind'),
      status: z.enum(DOCUMENT_STATUSES).optional(),
      search: z.string().max(120).optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    readOnly: true,
    run: (client, { kinds, ...rest }) =>
      client.request('GET', `${BASE}/documents`, {
        query: definedOnly({ ...rest, kinds: kinds?.length ? kinds.join(',') : undefined }),
        root: true,
      }),
  },
  {
    name: 'get_sales_document',
    title: 'Get an invoice or offer',
    description:
      'Fetch one document with its lines and totals (view=document, default), or a related read: events (history), payments, credit_summary (credited vs outstanding), payment_link (hosted pay-page URL, finalized invoices), dunning_preview (the next reminder, unsent).',
    schema: {
      documentId: z.string(),
      view: z
        .enum(['document', 'events', 'payments', 'credit_summary', 'payment_link', 'dunning_preview'])
        .optional(),
    },
    readOnly: true,
    run: (client, { documentId, view }) => {
      const suffix: Record<string, string> = {
        events: '/events',
        payments: '/payments',
        credit_summary: '/credit-notes',
        payment_link: '/payment-link',
        dunning_preview: '/dunning/preview',
      }
      return client.request('GET', documentPath(documentId, suffix[view ?? 'document'] ?? ''), {
        root: true,
      })
    },
  },
  {
    name: 'get_invoicing_config',
    title: 'Read invoicing setup',
    description:
      'Read invoicing setup: kind=settings (seller data, tax, dunning, DATEV), products (id optional for one), bank_accounts, number_ranges (numbering per document kind) or recurring (recurring invoices, id optional for one).',
    schema: {
      kind: z.enum(['settings', 'products', 'bank_accounts', 'number_ranges', 'recurring']),
      id: z.string().optional().describe('Only for products and recurring'),
    },
    readOnly: true,
    run: async (client, { kind, id }) => {
      need(!id || CONFIG_READS_WITH_ID.has(kind), `id is only supported for kind products or recurring`)
      const path = CONFIG_READS[kind as keyof typeof CONFIG_READS]
      return client.request('GET', id ? `${path}/${enc(id)}` : path, { root: true })
    },
  },
  {
    name: 'get_invoice_buyer_prefill',
    title: 'Get buyer data from the CRM',
    description:
      'Buyer fields for a new document taken from a CRM company. Without contactId it lists the company\'s contacts (to pick one); with contactId it returns the buyer block for that contact, ready to use as the buyer of a draft.',
    schema: {
      crmCompanyId: z.string(),
      contactId: z.string().optional().describe('Omit to list the company\'s contacts'),
    },
    readOnly: true,
    run: (client, { crmCompanyId, contactId }) =>
      contactId
        ? client.request('GET', `${BASE}/buyer-prefill/company/${enc(crmCompanyId)}`, {
            query: { contactId },
            root: true,
          })
        : client.request('GET', `${BASE}/buyer-prefill/company/${enc(crmCompanyId)}/contacts`, {
            root: true,
          }),
  },

  // ---- Documents: drafts ------------------------------------------------
  {
    name: 'save_sales_document_draft',
    title: 'Create or edit a draft document',
    description:
      'Create a draft (no documentId; buyer required, kind defaults to invoice) or edit an existing DRAFT (documentId; only the fields you send change, lines replaces the whole list). Drafts have no number and reach nobody; finalizing and sending are separate tools. Amounts are net, in major currency units; percentages are plain (19 = 19 %). Check the returned totals.',
    schema: {
      documentId: z.string().optional().describe('Set to edit an existing draft'),
      kind: z.enum(DOCUMENT_KINDS).optional().describe('Only when creating. Default invoice'),
      appointmentId: z.string().uuid().optional().describe('Only when creating: appointment this bills'),
      ...draftShape,
    },
    readOnly: false,
    run: async (client, { documentId, kind, appointmentId, ...fields }) => {
      if (documentId) {
        need(!kind && !appointmentId, 'kind and appointmentId can only be set when creating a draft')
        return client.request('PATCH', documentPath(documentId), {
          body: definedOnly(fields),
          root: true,
        })
      }
      need(fields.buyer, 'buyer is required to create a document')
      return client.request('POST', `${BASE}/documents`, {
        body: definedOnly({ kind, appointmentId, ...fields }),
        root: true,
      })
    },
  },
  {
    name: 'delete_sales_document_draft',
    title: 'Delete a draft document',
    description:
      'Delete a DRAFT document (drafts only; finalized documents cannot be deleted, cancel it via the status tool). Confirm with the user first.',
    schema: { documentId: z.string() },
    readOnly: false,
    destructive: true,
    run: (client, { documentId }) => client.request('DELETE', documentPath(documentId), { root: true }),
  },

  // ---- Documents: actions that stay inside meetergo ---------------------
  {
    name: 'manage_sales_document',
    title: 'Duplicate, convert or prepare a document',
    description:
      'Non-sending document actions: duplicate (copy as a new draft), convert_to_invoice (offer to invoice), create_credit_note (draft Gutschrift over all or selected lines of an invoice; reason required; not issued yet), dunning_pause (paused true/false excludes the invoice from automatic reminders).',
    schema: {
      documentId: z.string(),
      action: z.enum(['duplicate', 'convert_to_invoice', 'create_credit_note', 'dunning_pause']),
      reason: z.string().max(500).optional().describe('create_credit_note: printed on the credit note'),
      lineIds: z
        .array(z.string().uuid())
        .optional()
        .describe('create_credit_note: credit only these invoice line ids; omit for all lines'),
      paused: z.boolean().optional().describe('dunning_pause: required'),
    },
    readOnly: false,
    run: async (client, { documentId, action, reason, lineIds, paused }) => {
      switch (action) {
        case 'duplicate':
          return client.request('POST', documentPath(documentId, '/duplicate'), { root: true })
        case 'convert_to_invoice':
          return client.request('POST', documentPath(documentId, '/convert-to-invoice'), { root: true })
        case 'create_credit_note':
          need(reason, 'reason is required for create_credit_note')
          return client.request('POST', documentPath(documentId, '/credit-note'), {
            body: definedOnly({ reason, lineIds: lineIds?.length ? lineIds : undefined }),
            root: true,
          })
        case 'dunning_pause':
          need(typeof paused === 'boolean', 'paused (true/false) is required for dunning_pause')
          return client.request('POST', documentPath(documentId, '/dunning-pause'), {
            body: { paused },
            root: true,
          })
        default:
          throw new Error(`unknown action: ${action}`)
      }
    },
  },

  // ---- Documents: actions that reach a customer -----------------------
  {
    name: 'send_sales_document',
    title: 'Send a document to the customer',
    description: `Sends mail or WhatsApp to the customer: channel email (document, with pay link by default), whatsapp (needs phoneNumberId; the message links the hosted pay page) or dunning_reminder (reminder on the company letterhead; look at the dunning_preview view first). To overrides the recipient (email channels), phone the WhatsApp number. ${CONFIRM}`,
    schema: {
      documentId: z.string(),
      channel: z.enum(['email', 'whatsapp', 'dunning_reminder']),
      to: z.string().email().optional().describe('Recipient override, default the buyer email'),
      includePaymentLink: z
        .boolean()
        .optional()
        .describe('email: add the pay-page link (invoices; default true, omitted if no payment provider)'),
      phoneNumberId: z
        .string()
        .optional()
        .describe('whatsapp: WhatsApp Business phone number id (settings.dunning.whatsappPhoneNumberId, if set)'),
      phone: z.string().max(32).optional().describe('whatsapp: recipient override, default the buyer phone'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: (client, { documentId, channel, to, includePaymentLink, phoneNumberId, phone }) => {
      switch (channel) {
        case 'email':
          return client.request('POST', documentPath(documentId, '/send'), {
            body: definedOnly({ to, includePaymentLink }),
            root: true,
          })
        case 'whatsapp':
          return client.request('POST', documentPath(documentId, '/send-whatsapp'), {
            body: definedOnly({ phoneNumberId, phone }),
            root: true,
          })
        case 'dunning_reminder':
          return client.request('POST', documentPath(documentId, '/dunning/send'), {
            body: definedOnly({ to }),
            root: true,
          })
        default:
          throw new Error(`unknown channel: ${channel}`)
      }
    },
  },

  // ---- Documents: financial, irreversible --------------------------------
  {
    name: 'change_sales_document_status',
    title: 'Finalize, cancel or issue a document',
    description: `Irreversible status changes: finalize (draft becomes a legally binding document and consumes the next number; profile zugferd-en16931 default or xrechnung-cii), cancel (cancels a finalized document), issue_credit_note (documentId is the credit-note draft id; issues it and offsets the receivable), accept_offer / reject_offer (sets the offer status; accepting an offer with a deposit may create a deposit invoice). ${CONFIRM}`,
    schema: {
      documentId: z.string().describe('For issue_credit_note: the credit-note draft id'),
      action: z.enum(['finalize', 'cancel', 'issue_credit_note', 'accept_offer', 'reject_offer']),
      profile: z.enum(['zugferd-en16931', 'xrechnung-cii']).optional().describe('finalize only'),
    },
    readOnly: false,
    destructive: true,
    run: (client, { documentId, action, profile }) => {
      switch (action) {
        case 'finalize':
          return client.request('POST', documentPath(documentId, '/finalize'), {
            body: definedOnly({ profile }),
            root: true,
          })
        case 'cancel':
          return client.request('POST', documentPath(documentId, '/cancel'), { root: true })
        case 'issue_credit_note':
          return client.request('POST', `${BASE}/credit-notes/${enc(documentId)}/issue`, { root: true })
        case 'accept_offer':
        case 'reject_offer':
          return client.request('POST', documentPath(documentId, '/offer-status'), {
            body: { status: action === 'accept_offer' ? 'accepted' : 'rejected' },
            root: true,
          })
        default:
          throw new Error(`unknown action: ${action}`)
      }
    },
  },
  {
    name: 'manage_document_payment',
    title: 'Record or delete a payment',
    description:
      'Book a manual payment on a document (action record: amount, method bank_transfer/cash/other, optional paidAt and note) or remove one (action delete: paymentId from the payments view of the document). The amount is sent unchanged and the spec does not state its unit (minimum 1 suggests minor units, i.e. cents): compare with amountPaid/grossTotal of the document before and after. Confirm amount and document with the user first.',
    schema: {
      documentId: z.string(),
      action: z.enum(['record', 'delete']),
      amount: z.number().min(1).optional().describe('record: required, unit as described above'),
      method: z.enum(['bank_transfer', 'cash', 'other']).optional().describe('record: required'),
      paidAt: z.string().optional().describe('record: value date, ISO 8601, default now'),
      note: z.string().max(500).optional().describe('record: note'),
      paymentId: z.string().optional().describe('delete: required'),
    },
    readOnly: false,
    destructive: true,
    run: async (client, { documentId, action, amount, method, paidAt, note, paymentId }) => {
      if (action === 'delete') {
        need(paymentId, 'paymentId is required for delete')
        return client.request('DELETE', documentPath(documentId, `/payments/${enc(paymentId)}`), {
          root: true,
        })
      }
      need(amount !== undefined && method, 'amount and method are required for record')
      return client.request('POST', documentPath(documentId, '/payments'), {
        body: definedOnly({ amount, method, paidAt, note }),
        root: true,
      })
    },
  },

  // ---- Setup writes -----------------------------------------------------
  {
    name: 'update_invoicing_config',
    title: 'Change invoicing setup',
    description:
      'Write invoicing setup. kind + op: settings/update (seller data, tax, bank, dunning, DATEV; send only fields to change), product/create|update|delete, bank_account/create|update|delete, number_range/update (id = document kind; format e.g. RE-{YYYY}-{####}, nextCounter = next number to hand out), recurring/create|update|delete. data carries the fields: product {name*, unitPrice* (net, major units), unit, unitCode, kind service|good, currency, taxCategory, taxRate, active, ...}; bank_account {label*, iban*, bic, bankName, currency, isDefault}; recurring {name*, template* (full draft incl. buyer), interval weekly|monthly|quarterly|semiannually|yearly, nextRunAt*, endDate, autoFinalize, autoSend, active}. Settings and numbering affect legal documents, and recurring with autoSend mails customers by itself: confirm with the user first.',
    schema: {
      kind: z.enum(['settings', 'product', 'bank_account', 'number_range', 'recurring']),
      op: z.enum(['create', 'update', 'delete']),
      id: z.string().optional().describe('Record id; for number_range the document kind'),
      data: z.record(z.string(), z.unknown()).optional().describe('Fields for create/update, see description'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
    run: async (client, { kind, op, id, data }) => {
      const label = `${kind}/${op}`
      if (kind === 'settings' || kind === 'number_range') {
        need(op === 'update', `${kind} only supports op update`)
        if (kind === 'settings') {
          return client.request('PUT', `${BASE}/settings`, {
            body: parseData(settingsUpdate, data, label),
            root: true,
          })
        }
        need(id, 'id (the document kind, e.g. invoice) is required for number_range')
        return client.request('PUT', `${BASE}/number-ranges/${enc(id)}`, {
          body: parseData(numberRangeUpdate, data, label),
          root: true,
        })
      }

      const path = { product: 'products', bank_account: 'bank-accounts', recurring: 'recurring' }[
        kind as 'product' | 'bank_account' | 'recurring'
      ]
      const schemas = {
        product: { create: productCreate, update: productUpdate },
        bank_account: { create: bankCreate, update: bankUpdate },
        recurring: { create: recurringCreate, update: recurringUpdate },
      }[kind as 'product' | 'bank_account' | 'recurring']
      if (op === 'create') {
        return client.request('POST', `${BASE}/${path}`, {
          body: parseData(schemas.create, data, label),
          root: true,
        })
      }
      need(id, `id is required for ${label}`)
      if (op === 'delete') {
        return client.request('DELETE', `${BASE}/${path}/${enc(id)}`, { root: true })
      }
      return client.request('PATCH', `${BASE}/${path}/${enc(id)}`, {
        body: parseData(schemas.update, data, label),
        root: true,
      })
    },
  },
]

// ---- Output schemas -----------------------------------------------------

const done = out(
  { ok: bool.describe('true when the API returned an empty success') },
  'Empty success. Any fields present are what the API echoed back.',
)

/** A sales document. Money may arrive as number or decimal string, so it is not pinned. */
const salesDocument = out(
  {
    id: str,
    kind: any('offer, order_confirmation, invoice, credit_note or cancellation'),
    status: any('draft, finalized, sent, partially_paid, paid, cancelled, accepted or rejected'),
    number: str.describe('Legal number, assigned at finalization; null on drafts'),
    issueDate: str,
    dueDate: str,
    currency: str,
    buyer: any('Buyer block (name, address, email, phone, vatId, reference)'),
    netTotal: numOrStr.describe('Net total, major currency units'),
    taxTotal: numOrStr,
    grossTotal: numOrStr,
    amountPaid: numOrStr.describe('Unit as stored by the API; compare with grossTotal'),
    dunningLevel: numOrStr,
    dunningPaused: bool,
    lines: list(record),
  },
  'Sales document. Fields per API; only the stable ones are typed.',
)

export const INVOICING_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  list_sales_documents: out(
    { items: any('Documents; response shape per API, may be a paginated envelope') },
    'Page of documents',
  ),
  get_sales_document: out(
    {
      id: str,
      number: str,
      currency: str,
      items: any('Wrapped list for views events and payments'),
    },
    'The document, or the related data for the chosen view (payment link, credit summary, dunning preview); shape per API',
  ),
  get_invoicing_config: out(
    { id: str, items: any('Wrapped list for products, bank accounts, number ranges and recurring invoices') },
    'Settings object, or a list/record for the other kinds; shape per API',
  ),
  get_invoice_buyer_prefill: out(
    { items: any('Contacts when no contactId was given') },
    'Buyer block for the contact, or the company contacts; shape per API',
  ),
  save_sales_document_draft: salesDocument,
  delete_sales_document_draft: done,
  manage_sales_document: salesDocument,
  send_sales_document: out({ ok: bool }, 'Delivery result; response shape per API'),
  change_sales_document_status: salesDocument,
  manage_document_payment: out(
    {
      id: str,
      documentId: str,
      amount: numOrStr.describe('Unit as stored by the API'),
      currency: str,
      method: any('bank_transfer, cash, other, ...'),
      status: any('pending, completed or failed'),
      paidAt: str,
      note: str,
      ok: bool,
    },
    'The recorded payment, or an empty success after delete',
  ),
  update_invoicing_config: out(
    { id: str, ok: bool },
    'The saved record, or an empty success after delete; shape per API',
  ),
}
