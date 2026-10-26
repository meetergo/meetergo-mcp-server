import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MeetergoApiError, type MeetergoClient } from '../client.js'
import { explainDeniedAccess, PLAN_FEATURES } from '../plan-access.js'
import { buildServer } from '../server.js'
import { TOOLS } from '../tools.js'

/** A client whose account read answers the given plan, and whose other calls fail as told. */
function planClient(featureAccess: Record<string, unknown>, failWith?: Error) {
  const calls: string[] = []
  const client = {
    dashboardUrl: 'https://my.test',
    nextUrl: 'https://next.test',
    request: (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      if (path === '/user/me') {
        return Promise.resolve({ company: { tier: 'growth', isInTrial: false, featureAccess } })
      }
      return failWith ? Promise.reject(failWith) : Promise.resolve({})
    },
  } as unknown as MeetergoClient
  return { client, calls }
}

const forbidden = new MeetergoApiError(403, 'Forbidden resource')

describe('plan access', () => {
  it('only maps tools that exist, each to one feature', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    const seen = new Set<string>()
    for (const [feature, { tools }] of Object.entries(PLAN_FEATURES)) {
      for (const tool of tools) {
        expect(names.has(tool), `${feature}: unknown tool ${tool}`).toBe(true)
        expect(seen.has(tool), `${tool} mapped twice`).toBe(false)
        seen.add(tool)
      }
    }
  })

  it('names the missing feature and the plan when a mapped tool is refused', async () => {
    const { client } = planClient({ roundRobin: false })
    const message = await explainDeniedAccess(client, 'list_queues', forbidden)
    expect(message).toMatch(/^Not booked: "Round Robin queues" \(featureAccess\.roundRobin\)/)
    expect(message).toContain('(growth)')
    expect(message).toContain('Nothing was changed')
    expect(message).toContain('https://my.test/admin/subscription?feature=roundRobin')
  })

  it('stays silent when the feature is booked, the tool is unmapped, or the error is not a 403', async () => {
    const booked = planClient({ roundRobin: true })
    expect(await explainDeniedAccess(booked.client, 'list_queues', forbidden)).toBeUndefined()
    // A numeric allowance counts as booked, -1 meaning unlimited.
    const limit = planClient({ invoicing: -1 })
    expect(await explainDeniedAccess(limit.client, 'list_sales_documents', forbidden)).toBeUndefined()

    const none = planClient({})
    expect(await explainDeniedAccess(none.client, 'get_me', forbidden)).toBeUndefined()
    expect(await explainDeniedAccess(none.client, 'list_queues', new MeetergoApiError(500, 'x'))).toBeUndefined()
    expect(none.calls).toEqual([])
  })

  it('treats 0 as not booked, and an account read that fails as unexplained', async () => {
    const zero = planClient({ invoicing: 0 })
    expect(await explainDeniedAccess(zero.client, 'list_sales_documents', forbidden)).toMatch(/Invoicing/)

    const broken = { dashboardUrl: '', request: () => Promise.reject(new Error('down')) } as unknown as MeetergoClient
    expect(await explainDeniedAccess(broken, 'list_queues', forbidden)).toBeUndefined()
  })

  it('reads the account once for repeated refusals', async () => {
    const { client, calls } = planClient({ handoff: false })
    await explainDeniedAccess(client, 'list_handoff_options', forbidden)
    await explainDeniedAccess(client, 'handoff_appointments', forbidden)
    expect(calls.filter((c) => c === 'GET /user/me')).toHaveLength(1)
  })

  it('check_plan_access reports every area, or the area of one tool', async () => {
    const tool = TOOLS.find((t) => t.name === 'check_plan_access')!
    expect(tool.readOnly).toBe(true)
    const { client } = planClient({ roundRobin: false, invoicing: true, whatsappAddon: false })

    const all = (await tool.run(client, {})) as { tier: string; features: Array<{ feature: string; booked: boolean }> }
    expect(all.tier).toBe('growth')
    expect(all.features.find((f) => f.feature === 'roundRobin')?.booked).toBe(false)
    expect(all.features.find((f) => f.feature === 'invoicing')?.booked).toBe(true)
    // A flag the account data does not mention is not booked either.
    expect(all.features.find((f) => f.feature === 'handoff')?.booked).toBe(false)

    const one = (await tool.run(client, { tool: 'send_whatsapp_message' })) as { features: Array<{ feature: string }> }
    expect(one.features.map((f) => f.feature)).toEqual(['whatsappAddon'])

    const unknown = (await tool.run(client, { tool: 'get_me' })) as { features: unknown[]; note?: string }
    expect(unknown.features).toEqual([])
    expect(unknown.note).toMatch(/No plan requirement/)
  })

  it('turns a refused tool call into the not-booked message through the server', async () => {
    const { client: upstream } = planClient({ roundRobin: false }, forbidden)
    const server = buildServer(upstream, '0.0.0-test')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test', version: '0' })
    await server.connect(serverTransport)
    await mcp.connect(clientTransport)

    const result = await mcp.callTool({ name: 'list_queues', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/^Not booked: "Round Robin queues"/)

    // A refusal that is not about the plan keeps the API's own wording.
    const other = await mcp.callTool({ name: 'get_me', arguments: {} })
    expect(other.isError).toBeFalsy()
  })
})
