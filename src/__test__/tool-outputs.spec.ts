import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { MeetergoClient, RequestOptions } from '../client.js'
import { buildServer } from '../server.js'
import { deriveSetupStatus } from '../setup-status.js'
import { TOOL_OUTPUTS, toStructuredContent } from '../tool-outputs.js'
import { TOOLS } from '../tools.js'

/**
 * The property that matters: an output schema must never turn a working tool
 * into a protocol error. The SDK validates structuredContent against the
 * schema and fails the call on mismatch, so every schema has to accept
 * whatever the API can plausibly return — including nothing, a bare list,
 * and fields we did not anticipate.
 */
describe('tool output schemas', () => {
  it('exist for every tool, and only for tools', () => {
    const names = TOOLS.map((t) => t.name)
    for (const name of names) expect(TOOL_OUTPUTS[name]).toBeDefined()
    expect(Object.keys(TOOL_OUTPUTS).sort()).toEqual([...names].sort())
  })

  /** Tools whose result this server builds itself, so the shape is exact. */
  const EXACT = new Set([
    'get_mira_widget_embed',
    'get_setup_status',
    'verify_widget_install',
  ])

  it('accept an empty object, a wrapped list, an empty result and unknown fields', () => {
    for (const tool of TOOLS) {
      if (EXACT.has(tool.name)) continue
      const schema = TOOL_OUTPUTS[tool.name]
      for (const sample of [
        {},
        { items: [] },
        { items: [{ anything: 1 }] },
        { ok: true },
        { unexpected: { nested: ['x'] } },
      ]) {
        const parsed = schema.safeParse(sample)
        expect(
          parsed.success,
          `${tool.name} rejected ${JSON.stringify(sample)}: ${
            parsed.success ? '' : parsed.error.message
          }`,
        ).toBe(true)
      }
    }
  })

  it('accept null for every field the API owns', () => {
    for (const tool of TOOLS) {
      if (EXACT.has(tool.name)) continue
      const schema = TOOL_OUTPUTS[tool.name]
      const nulls = Object.fromEntries(
        Object.keys(schema.shape).map((key) => [key, null]),
      )
      const parsed = schema.safeParse(nulls)
      expect(
        parsed.success,
        `${tool.name}: ${parsed.success ? '' : parsed.error.message}`,
      ).toBe(true)
    }
  })

  it('match the shapes this server computes itself', () => {
    expect(
      TOOL_OUTPUTS.get_setup_status.safeParse(
        deriveSetupStatus({
          settings: {},
          knowledgeDocumentCount: 0,
          meetingTypeCount: 0,
        }),
      ).success,
    ).toBe(true)
    expect(
      TOOL_OUTPUTS.verify_widget_install.safeParse({
        installed: false,
        foundLoader: false,
        foundKey: false,
        checkedUrl: 'https://example.com/',
        hint: 'x',
      }).success,
    ).toBe(true)
    expect(
      TOOL_OUTPUTS.get_mira_widget_embed.safeParse({
        publicKey: 'k',
        enabled: false,
        allowedDomains: [],
        loaderUrl: 'https://next.test/mira-widget.js',
        snippet: '<script></script>',
        widgetPageUrl: 'https://next.test/mira-widget?key=k',
        previewUrl: 'https://next.test/mira-widget?key=k&preview=1',
      }).success,
    ).toBe(true)
  })

  it('wrap non-object results so structured content always exists', () => {
    expect(toStructuredContent(undefined)).toEqual({ ok: true })
    expect(toStructuredContent(null)).toEqual({ ok: true })
    expect(toStructuredContent([1, 2])).toEqual({ items: [1, 2] })
    expect(toStructuredContent({ a: 1 })).toEqual({ a: 1 })
    expect(toStructuredContent('done')).toEqual({ value: 'done' })
  })
})

describe('tool output schemas over the wire', () => {
  function fakeClient(responses: Record<string, unknown>): MeetergoClient {
    return {
      nextUrl: 'https://next.test',
      request: (_method: string, path: string, _options?: RequestOptions) =>
        Promise.resolve(responses[path]),
    } as unknown as MeetergoClient
  }

  async function connect(responses: Record<string, unknown>) {
    const server = buildServer(fakeClient(responses), '0.0.0-test')
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return client
  }

  it('advertises an open output schema on every tool', async () => {
    const client = await connect({})
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(TOOLS.length)
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined()
      expect(tool.outputSchema?.type).toBe('object')
      // Passthrough → the published JSON schema must not forbid extra keys.
      expect(tool.outputSchema?.additionalProperties, tool.name).not.toBe(
        false,
      )
    }
  })

  it('serves schemas a strict, 2020-12-only client can compile', async () => {
    // The vendored zod-to-json-schema converter the SDK's own tools/list
    // handler uses stamps every schema with `$schema: draft-07`. Claude
    // Desktop's MCP integration builds a default AjvJsonSchemaValidator
    // (2020-12 only) to validate output before a tool call even runs, and
    // Ajv configurations that only load the 2020-12 meta-schema refuse to
    // compile a schema that names a different one — failing every tool
    // with an outputSchema, not just the ones with an unusual shape.
    const client = await connect({})
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(TOOLS.length)

    const validator = new AjvJsonSchemaValidator()
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined()
      expect(() => validator.getValidator(tool.inputSchema), tool.name).not.toThrow()
      expect(() => validator.getValidator(tool.outputSchema!), tool.name).not.toThrow()
    }
    expect(JSON.stringify(tools)).not.toContain('$schema')
  })

  it('advertises reviewer-ready titles and concrete input parameter types', async () => {
    const client = await connect({})
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.annotations?.title, tool.name).toBe(tool.title)
    }

    const listAppointments = tools.find(
      (tool) => tool.name === 'list_appointments',
    )
    expect(listAppointments?.inputSchema.properties?.end).toMatchObject({
      type: 'string',
    })
  })

  it('validates a bare list, an empty delete and a real object end to end', async () => {
    // The SDK client validates structuredContent against outputSchema and
    // throws on mismatch — so these calls succeeding is the whole point.
    const client = await connect({
      '/meeting-type': [{ id: 'mt-1', meetingInfo: { name: 'Intro', duration: 30 } }],
      '/webhooks/wh-1': undefined,
      '/user/me': { id: 'u-1', email: 'me@example.com', extra: { deep: true } },
    })

    const list = await client.callTool({ name: 'list_meeting_types', arguments: {} })
    expect(list.isError).toBeFalsy()
    expect(list.structuredContent).toEqual({
      items: [{ id: 'mt-1', meetingInfo: { name: 'Intro', duration: 30 } }],
    })

    const del = await client.callTool({
      name: 'delete_webhook',
      arguments: { webhookId: 'wh-1' },
    })
    expect(del.isError).toBeFalsy()
    expect(del.structuredContent).toEqual({ ok: true })

    const me = await client.callTool({ name: 'get_me', arguments: {} })
    expect(me.isError).toBeFalsy()
    expect(me.structuredContent).toMatchObject({ id: 'u-1', extra: { deep: true } })
  })

  it('does not validate error results', async () => {
    const client = await connect({})
    const result = await client.callTool({
      name: 'get_contact',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
  })
})
