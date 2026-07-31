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
 *         "env": { "MEETERGO_TOKEN": "rgo-..." }
 *       }
 *     }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  DEFAULT_BASE_URL,
  isPlatformApiKey,
  MeetergoApiError,
  MeetergoClient,
} from './client.js'
import { TOOLS } from './tools.js'

const VERSION = '0.2.0'

interface Credentials {
  token: string
  userId?: string
}

function readCredentials(): Credentials {
  const token = process.env.MEETERGO_TOKEN?.trim()
  const userId = process.env.MEETERGO_USER_ID?.trim()

  if (!token) {
    // Fail here rather than on the first tool call: an agent that discovers the
    // auth problem three steps into a booking has already told the user it is
    // scheduling something.
    fail(
      'MEETERGO_TOKEN is not set.\n' +
        'Create a Personal Access Token (rgo-...) at https://my.meetergo.com/integrations\n' +
        'and pass it in the server env block.',
    )
  }

  if (userId && !isPlatformApiKey(token)) {
    fail(
      'MEETERGO_USER_ID is set, but MEETERGO_TOKEN is not a Platform API Key.\n' +
        'A Personal Access Token always acts as its own owner and the API rejects\n' +
        'the impersonation header. Either drop MEETERGO_USER_ID, or use a\n' +
        'Platform API Key (ak_live:<uuid>:<secret>).',
    )
  }

  if (!userId && isPlatformApiKey(token)) {
    // A Platform API Key names no user of its own, so the API demands the
    // acting user on every route that is not explicitly exempt. Without it the
    // server would start, answer get_me, then 400 on list_meeting_types — which
    // reads to an agent like an empty account rather than a misconfiguration.
    fail(
      'MEETERGO_TOKEN is a Platform API Key, but MEETERGO_USER_ID is not set.\n' +
        'A Platform API Key must name the user to act as. Set MEETERGO_USER_ID to\n' +
        "that user's UUID, or use a Personal Access Token (rgo-...) instead.",
    )
  }

  return { token, userId: userId || undefined }
}

function fail(message: string): never {
  process.stderr.write(`meetergo MCP: ${message}\n`)
  process.exit(1)
}

function readTimeout(): number | undefined {
  const raw = process.env.MEETERGO_TIMEOUT_MS?.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`MEETERGO_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}"`)
  }
  return parsed
}

async function main(): Promise<void> {
  const { token, userId } = readCredentials()

  const client = new MeetergoClient({
    token,
    userId,
    baseUrl: process.env.MEETERGO_API_URL ?? DEFAULT_BASE_URL,
    timeoutMs: readTimeout(),
    userAgent: `meetergo-mcp/${VERSION}`,
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
          // Booking and cancelling are not idempotent, and cancelling destroys
          // something. Hosts use these to decide what to confirm with a human,
          // so getting them right matters more than it looks.
          idempotentHint: tool.readOnly,
          destructiveHint: tool.destructive ?? false,
        },
      },
      async (args) => {
        try {
          const result = await tool.run(client, args)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result ?? { ok: true }, null, 2),
              },
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
