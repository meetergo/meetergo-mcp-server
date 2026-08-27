import { runInNewContext } from 'node:vm'
import {
  SETUP_STATUS_HTML,
  SETUP_STATUS_TEMPLATE_URI,
  UI_MIME,
  UI_RESOURCE_META,
  UPGRADE_CARD_HTML,
  UPGRADE_CARD_TEMPLATE_URI,
} from '../ui.js'

class FakeElement {
  hidden = true
  textContent = ''
  className = ''
  href = ''
  style: Record<string, string> = {}
  children: FakeElement[] = []

  append(...children: FakeElement[]) {
    this.children.push(...children)
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children
  }
}

interface BridgeEvent {
  source: object
  data: {
    jsonrpc: string
    method: string
    params: { structuredContent: unknown }
  }
}

function loadWidget(html: string, legacyOutput?: unknown) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('widget script not found')

  const elements = new Map<string, FakeElement>()
  const listeners = new Map<string, (event: BridgeEvent) => void>()
  const parent = {}
  const window = {
    parent,
    ...(legacyOutput === undefined
      ? {}
      : { openai: { toolOutput: legacyOutput } }),
    addEventListener: (name: string, listener: (event: BridgeEvent) => void) =>
      listeners.set(name, listener),
  }
  const document = {
    getElementById: (id: string) => {
      const element = elements.get(id) ?? new FakeElement()
      elements.set(id, element)
      return element
    },
    createElement: () => new FakeElement(),
  }

  runInNewContext(script, { window, document })

  return {
    element: (id: string) => document.getElementById(id),
    sendToolResult: (structuredContent: unknown) => {
      const listener = listeners.get('message')
      if (!listener)
        throw new Error('widget did not register a message listener')
      listener({
        source: parent,
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: { structuredContent },
        },
      })
    },
  }
}

describe('ChatGPT UI resource metadata', () => {
  it('uses the standard MCP Apps MIME type and versioned cache keys', () => {
    expect(UI_MIME).toBe('text/html;profile=mcp-app')
    expect(SETUP_STATUS_TEMPLATE_URI).toBe('ui://meetergo/setup-status/v2.html')
    expect(UPGRADE_CARD_TEMPLATE_URI).toBe('ui://meetergo/upgrade-card/v2.html')
  })

  it('uses a plugin-owned origin and a least-privilege CSP', () => {
    expect(UI_RESOURCE_META).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
        },
        domain: 'https://mcp.meetergo.com',
        prefersBorder: true,
      },
      'openai/widgetCSP': {
        connect_domains: [],
        resource_domains: [],
      },
      'openai/widgetDomain': 'https://mcp.meetergo.com',
      'openai/widgetPrefersBorder': true,
    })
  })
})

describe('MCP Apps widget bridge', () => {
  it('renders setup status delivered through a tool-result notification', () => {
    const widget = loadWidget(SETUP_STATUS_HTML)

    widget.sendToolResult({
      done: 1,
      total: 2,
      steps: [
        { key: 'bookable', done: true },
        { key: 'assistant', done: false },
      ],
    })

    expect(widget.element('root').hidden).toBe(false)
    expect(widget.element('headline').textContent).toBe('1 step from live')
    expect(widget.element('subline').textContent).toBe('1 of 2 done')
    expect(widget.element('meter').style.width).toBe('50%')
    expect(widget.element('steps').children).toHaveLength(2)
  })

  it('keeps the synchronous ChatGPT compatibility payload working', () => {
    const widget = loadWidget(SETUP_STATUS_HTML, {
      done: 2,
      total: 2,
      steps: [],
    })

    expect(widget.element('root').hidden).toBe(false)
    expect(widget.element('headline').textContent).toBe(
      'Live. Visitors can book through the assistant',
    )
  })

  it('renders a safe upgrade URL delivered through the standard bridge', () => {
    const widget = loadWidget(UPGRADE_CARD_HTML)

    widget.sendToolResult({
      planLimit: {
        feature: 'meeting type allowance',
        detail: 'The current allowance is used up.',
        upgradeUrl: 'https://app.meetergo.com/settings/billing',
      },
    })

    expect(widget.element('root').hidden).toBe(false)
    expect(widget.element('cta').href).toBe(
      'https://app.meetergo.com/settings/billing',
    )
  })
})
