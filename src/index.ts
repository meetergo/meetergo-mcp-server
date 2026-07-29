#!/usr/bin/env node
/**
 * meetergo MCP server — scheduling actions for AI agents.
 *
 * Distinct from the docs MCP at developer.meetergo.com/mcp, which searches
 * documentation and cannot change anything. This one books, reschedules,
 * cancels and reads calendars: the difference between an assistant that can
 * explain meetergo and an agent that can run your calendar.
 *
 * stdio transport, so it runs under Claude Desktop, Cursor, or anything that
 * speaks MCP, without meetergo hosting a per-user session.
 *
 *   {
 *     "mcpServers": {
 *       "meetergo": {
 *         "command": "npx",
 *         "args": ["-y", "@meetergo/mcp-server"],
 *         "env": { "MEETERGO_TOKEN": "pat_..." }
 *       }
 *     }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DEFAULT_BASE_URL, MeetergoApiError, MeetergoClient } from './client.js'
import { TOOLS } from './tools.js'

const VERSION = '0.1.1'

function readToken(): string {
  const token = process.env.MEETERGO_TOKEN?.trim()
  if (token) return token
  // Fail here rather than on the first tool call: an agent that discovers the
  // auth problem three steps into a booking has already told the user it is
  // scheduling something.
  process.stderr.write(
    'meetergo MCP: MEETERGO_TOKEN is not set.\n' +
      'Create a Personal Access Token at https://my.meetergo.com/integrations\n' +
      'and pass it in the server env block.\n',
  )
  process.exit(1)
}

async function main(): Promise<void> {
  const client = new MeetergoClient({
    token: readToken(),
    baseUrl: process.env.MEETERGO_API_URL ?? DEFAULT_BASE_URL,
  })

  const server = new McpServer({ name: 'meetergo', version: VERSION })

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.readOnly,
          // Booking and cancelling are not idempotent, and cancelling is
          // destructive. Hosts use these to decide what to confirm with a
          // human, so getting them right matters more than it looks.
          idempotentHint: tool.readOnly,
          destructiveHint: tool.name === 'cancel_appointment',
        },
      },
      async (args) => {
        try {
          const result = await tool.run(client, args)
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result ?? { ok: true }, null, 2) },
            ],
          }
        } catch (error: unknown) {
          // Returned as an error result, not thrown: the agent should be able
          // to read "that slot was taken" and pick another, rather than have
          // the whole tool call fail opaquely.
          const message =
            error instanceof MeetergoApiError
              ? error.message
              : `meetergo MCP: ${(error as Error).message}`
          return {
            isError: true,
            content: [{ type: 'text' as const, text: message }],
          }
        }
      },
    )
  }

  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  process.stderr.write(`meetergo MCP failed to start: ${String(error)}\n`)
  process.exit(1)
})
