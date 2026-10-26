/**
 * Plan awareness: which parts of the API this account has actually booked.
 *
 * Some endpoints answer a bare 403 "Forbidden resource" when the plan lacks the
 * feature (queues and handoff need Round Robin / Handoff, templates their own
 * flag). To an agent that reads like a broken token. The account data carries
 * `company.featureAccess`, so a refusal can be turned into the precise
 * statement "not booked: X" — and an agent can ask up front.
 *
 * The check runs only AFTER a refusal, never as a gate before a call. A flag
 * can be false while a read still works (the template list answers 200 on a
 * plan without the templates feature), so blocking up front would turn working
 * calls into false "not booked" answers.
 */
import { z } from 'zod/v3'
import type { MeetergoClient } from './client.js'
import { MeetergoApiError } from './client.js'
import { bool, list, out, str } from './output-helpers.js'
import type { ToolDefinition } from './tools.js'

interface PlanFeature {
  label: string
  tools: string[]
}

/** featureAccess key -> what it unlocks. Only features a tool here depends on. */
export const PLAN_FEATURES: Record<string, PlanFeature> = {
  roundRobin: {
    label: 'Round Robin queues',
    tools: ['list_queues', 'update_queue', 'manage_queue_user_group'],
  },
  handoff: {
    label: 'Handoff',
    tools: ['list_handoff_options', 'handoff_appointments'],
  },
  whatsappAddon: {
    label: 'WhatsApp add-on',
    tools: ['get_whatsapp', 'send_whatsapp_message'],
  },
  meetingTypeTemplates: {
    label: 'Meeting-type templates',
    tools: [
      'list_meeting_type_templates',
      'save_meeting_type_template',
      'assign_meeting_type_template',
      'delete_meeting_type_template',
    ],
  },
  routingForms: {
    label: 'Routing forms',
    tools: [
      'list_routing_forms',
      'get_routing_form',
      'create_routing_form',
      'update_routing_form',
      'delete_routing_form',
      'send_routing_form',
      'list_form_recipients',
    ],
  },
  invoicing: {
    label: 'Invoicing',
    tools: [
      'list_sales_documents',
      'get_sales_document',
      'get_invoicing_config',
      'get_invoice_buyer_prefill',
      'save_sales_document_draft',
      'delete_sales_document_draft',
      'manage_sales_document',
      'send_sales_document',
      'change_sales_document_status',
      'manage_document_payment',
      'update_invoicing_config',
    ],
  },
  dealSpace: {
    label: 'Spaces (client portals)',
    tools: [
      'list_spaces',
      'get_space',
      'save_space',
      'delete_space',
      'space_action',
      'edit_space_structure',
      'manage_space_link',
      'manage_space_people',
      'manage_space_section_template',
    ],
  },
}

const featureOfTool = new Map<string, string>(
  Object.entries(PLAN_FEATURES).flatMap(([feature, { tools }]) =>
    tools.map((tool) => [tool, feature] as const),
  ),
)

interface PlanSnapshot {
  tier?: string
  isInTrial?: boolean
  featureAccess: Record<string, unknown>
}

const CACHE_MS = 5 * 60_000
const cache = new WeakMap<MeetergoClient, { at: number; plan: Promise<PlanSnapshot> }>()

/** One account read per client per few minutes, however many refusals follow. */
function loadPlan(client: MeetergoClient): Promise<PlanSnapshot> {
  const hit = cache.get(client)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.plan
  const plan = client
    .request<{ company?: { tier?: string; isInTrial?: boolean; featureAccess?: Record<string, unknown> } }>(
      'GET',
      '/user/me',
    )
    .then((me) => ({
      tier: me?.company?.tier,
      isInTrial: me?.company?.isInTrial,
      featureAccess: me?.company?.featureAccess ?? {},
    }))
  cache.set(client, { at: Date.now(), plan })
  // A failed read must not stick for five minutes.
  plan.catch(() => cache.delete(client))
  return plan
}

/** true for an enabled flag or a non-zero allowance (-1 means unlimited). */
function isBooked(value: unknown): boolean {
  return value === true || (typeof value === 'number' && value !== 0)
}

/**
 * The precise "not booked" message for a refused call, or undefined when this
 * refusal is not explained by a missing plan feature (a role problem, an
 * unmapped tool, a flag that is set).
 */
export async function explainDeniedAccess(
  client: MeetergoClient,
  toolName: string,
  error: unknown,
): Promise<string | undefined> {
  if (!(error instanceof MeetergoApiError) || error.status !== 403) return undefined
  const feature = featureOfTool.get(toolName)
  if (!feature) return undefined
  let plan: PlanSnapshot
  try {
    plan = await loadPlan(client)
  } catch {
    return undefined
  }
  if (isBooked(plan.featureAccess[feature])) return undefined
  const { label } = PLAN_FEATURES[feature]
  return (
    `Not booked: "${label}" (featureAccess.${feature}) is not part of this account's plan` +
    `${plan.tier ? ` (${plan.tier})` : ''}, so ${toolName} cannot be used. Nothing was changed. ` +
    `It can be added at ${client.dashboardUrl}/admin/subscription?feature=${encodeURIComponent(feature)}&utm_source=mcp — ` +
    `mention this only because the requested action is blocked; do not turn it into a pitch.`
  )
}

export const PLAN_TOOLS: ToolDefinition[] = [
  {
    name: 'check_plan_access',
    title: 'Check which features the plan includes',
    description:
      'Report which optional areas this account has booked (Round Robin queues, Handoff, WhatsApp add-on, meeting-type templates, routing forms, invoicing, Spaces) and which tools depend on each. Use it to say up front that something is not booked instead of attempting it; pass tool to ask about one tool. A refused call is also explained automatically.',
    schema: {
      tool: z.string().optional().describe('Name of one tool to check; omit for every area'),
    },
    readOnly: true,
    run: async (client, { tool }) => {
      const plan = await loadPlan(client)
      const rows = Object.entries(PLAN_FEATURES)
        .filter(([feature]) => !tool || featureOfTool.get(tool) === feature)
        .map(([feature, { label, tools }]) => ({
          feature,
          label,
          booked: isBooked(plan.featureAccess[feature]),
          tools,
        }))
      return {
        tier: plan.tier ?? null,
        isInTrial: plan.isInTrial ?? null,
        ...(tool && rows.length === 0
          ? { note: `No plan requirement is known for ${tool}; if it is refused, the cause is the role or a missing argument.` }
          : {}),
        features: rows,
      }
    },
  },
]

export const PLAN_OUTPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  check_plan_access: out(
    {
      tier: str.describe('Plan tier of the company'),
      isInTrial: bool,
      note: str,
      features: list(
        out(
          {
            feature: str.describe('featureAccess key'),
            label: str,
            booked: bool.describe('false: the plan does not include it'),
            tools: list(z.string()),
          },
          'One optional area',
        ),
      ),
    },
    'What the plan includes, per area',
  ),
}

