import { TOOLS } from '../tools.js'

/**
 * These assertions are about the agent contract, not implementation detail.
 * A tool renamed or an annotation flipped silently changes what a host will
 * auto-run without asking a human — that is worth a failing test.
 */
describe('meetergo MCP tool surface', () => {
  it('exposes a curated surface, not the whole API', () => {
    // 100 operations exist. Nine is the deliberate ceiling: tool definitions
    // cost context, and selection accuracy falls as the list grows.
    expect(TOOLS).toHaveLength(9)
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length)
  })

  it('covers the full loop an agent needs to run a calendar', () => {
    const names = TOOLS.map((t) => t.name)
    for (const required of [
      'list_meeting_types', // discover
      'get_availability', // when
      'book_appointment', // schedule
      'reschedule_appointment', // change
      'cancel_appointment', // undo
      'list_appointments', // review
    ]) {
      expect(names).toContain(required)
    }
  })

  it('marks exactly the mutating tools as writes', () => {
    const writes = TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort()
    // Hosts gate confirmation on readOnlyHint. Mislabelling a write as a read
    // means an agent books or cancels without anyone being asked.
    expect(writes).toEqual([
      'add_guests',
      'book_appointment',
      'cancel_appointment',
      'reschedule_appointment',
    ])
  })

  it('gives every tool a description an agent can choose on', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.title).toBeTruthy()
    }
  })

  it('requires an identifier on every tool that changes something', () => {
    for (const tool of TOOLS.filter((t) => !t.readOnly)) {
      const keys = Object.keys(tool.schema)
      expect(keys.length).toBeGreaterThan(0)
      // Nothing mutating should be callable with no arguments at all.
      expect(
        keys.some((k) => k === 'appointmentId' || k === 'meetingTypeId'),
      ).toBe(true)
    }
  })
})

describe('release hygiene', () => {
  it('reports the version the package claims', async () => {
    // The server hardcodes VERSION and the manifest carries its own. They are
    // the same number in two files, which is a drift waiting to happen — the
    // mirror shipped 0.1.1 while the handshake still announced 0.1.0. An MCP
    // client showing the wrong server version makes every bug report wrong.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version: string }
    const source = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain(`const VERSION = '${pkg.version}'`)
  })
})
