import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'),
  ) as T
}

describe('Cursor Marketplace package', () => {
  it('points Cursor and Grok Bot at the hosted OAuth server', () => {
    const plugin = readJson<{
      name: string
      displayName: string
      description: string
      category: string
      logo: string
      mcpServers: string
    }>('../../.cursor-plugin/plugin.json')
    const mcp = readJson<{
      mcpServers: Record<
        string,
        {
          type: string
          url: string
          auth: {
            CLIENT_ID: string
            CLIENT_SECRET?: string
            scopes: string[]
          }
        }
      >
    }>('../../mcp.json')

    expect(plugin).toMatchObject({
      name: 'meetergo',
      displayName: 'meetergo',
      category: 'integrations',
      mcpServers: './mcp.json',
    })
    expect(plugin.description).toMatch(/book/i)
    expect(
      existsSync(fileURLToPath(new URL(`../../${plugin.logo}`, import.meta.url))),
    ).toBe(true)

    expect(mcp.mcpServers.meetergo).toEqual({
      type: 'http',
      url: 'https://mcp.meetergo.com/mcp',
      auth: {
        CLIENT_ID: 'mcp-cursor',
        scopes: ['openid'],
      },
    })
    expect(JSON.stringify(mcp)).not.toContain('CLIENT_SECRET')
  })
})
