import {
  analyzeInstallHtml,
  deriveSetupStatus,
  planFromMe,
} from '../setup-status.js'

const fresh = {
  settings: {},
  knowledgeDocumentCount: 0,
  meetingTypeCount: 0,
}

describe('deriveSetupStatus', () => {
  it('walks a fresh account from the beginning', () => {
    const status = deriveSetupStatus(fresh)
    expect(status.stage).toBe('fresh')
    expect(status.next).toBe('bookable')
    expect(status.done).toBe(0)
    // Every unmet step names the concrete tool to reach for.
    for (const step of status.steps) expect(step.action).toMatch(/[a-z]_[a-z]/)
  })

  it('reports ready when configured but not serving, live when serving', () => {
    const configured = {
      settings: {
        enabled: true,
        lastTestDrive: { at: '2026-08-06T10:00:00Z', passed: 5, total: 5 },
        assistantProfiles: [{ id: 'website-assistant' }],
        webChat: {
          publicKey: 'mira_pub_x',
          enabled: false,
          allowedDomains: ['example.com'],
        },
      },
      knowledgeDocumentCount: 50,
      meetingTypeCount: 2,
    }
    const ready = deriveSetupStatus(configured)
    expect(ready.stage).toBe('ready')
    expect(ready.next).toBe('live')

    const live = deriveSetupStatus({
      ...configured,
      settings: {
        ...configured.settings,
        webChat: { ...configured.settings.webChat, enabled: true },
      },
    })
    expect(live.stage).toBe('live')
    expect(live.next).toBeNull()
    expect(live.done).toBe(live.total)
  })

  it('counts any installed live channel, not only the first widget', () => {
    const status = deriveSetupStatus({
      settings: {
        assistantProfiles: [{ id: 'p1' }],
        channels: {
          webChat: [
            { publicKey: 'a', enabled: false, allowedDomains: [] },
            {
              publicKey: 'b',
              enabled: true,
              allowedDomains: ['shop.example.com'],
            },
          ],
        },
      },
      knowledgeDocumentCount: 1,
      meetingTypeCount: 1,
    })
    expect(status.stage).toBe('live')
  })

  it('never calls a switched-on widget live while the master switch is off', () => {
    const status = deriveSetupStatus({
      settings: {
        enabled: false,
        assistantProfiles: [{ id: 'p1' }],
        webChat: {
          publicKey: 'x',
          enabled: true,
          allowedDomains: ['example.com'],
        },
      },
      knowledgeDocumentCount: 1,
      meetingTypeCount: 1,
    })
    expect(status.stage).toBe('ready')
  })
})

describe('analyzeInstallHtml', () => {
  const key = 'mira_pub_c60b5d2d42a5'

  it('is installed only when the loader AND the own key are served', () => {
    const html = `<script src="https://cal.meetergo.com/mira-widget.js" data-mira-key="${key}" async></script>`
    expect(analyzeInstallHtml(html, key)).toEqual({
      foundLoader: true,
      foundKey: true,
      installed: true,
    })
  })

  it("catches someone else's snippet: loader present, wrong key", () => {
    const html = `<script src="/mira-widget.js" data-mira-key="mira_pub_other"></script>`
    const check = analyzeInstallHtml(html, key)
    expect(check.foundLoader).toBe(true)
    expect(check.installed).toBe(false)
  })

  it('reports a bare page as not installed', () => {
    expect(analyzeInstallHtml('<html><body>hi</body></html>', key).installed).toBe(
      false,
    )
  })
})

describe('planFromMe', () => {
  it('shapes tier and caps when the API exposes them', () => {
    const plan = planFromMe({
      company: {
        tier: 'basic',
        isInTrial: false,
        featureAccess: { knowledgePageLimit: 50, maxWorkflows: 0 },
      },
    })
    expect(plan).toMatchObject({
      tier: 'basic',
      trial: false,
      knowledgePageLimit: 50,
    })
    // The behavioural rule travels with the data.
    expect(String(plan?.note)).toMatch(/Only mention upgrading/)
  })

  it('yields nothing rather than guessing when the shape is unknown', () => {
    expect(planFromMe({})).toBeNull()
    expect(planFromMe({ company: {} })).toBeNull()
  })
})
