/**
 * Pure derivations behind the onboarding tools: where an account stands on the
 * path from "signed up" to "visitors booking through Mira", and whether a
 * website actually serves the widget. Mirrors the dashboard's launch runway
 * (apps/web functions/launch-checklist.ts) so the agent and the Home screen
 * can never tell different stories.
 */

interface WebChatLike {
  publicKey?: string | null
  enabled?: boolean
  allowedDomains?: string[]
}

export interface SetupStatusInput {
  settings: {
    enabled?: boolean
    lastTestDrive?: { at: string; passed: number; total: number } | null
    webChat?: WebChatLike
    assistantProfiles?: { id: string; name?: string }[]
    channels?: { webChat?: WebChatLike[] }
  }
  knowledgeDocumentCount: number
  meetingTypeCount: number
}

export interface SetupStep {
  key: 'bookable' | 'assistant' | 'knowledge' | 'testDrive' | 'install' | 'live'
  done: boolean
  /** What to do when not done — phrased as the agent's next move. */
  action: string
}

export interface SetupStatus {
  stage: 'fresh' | 'ready' | 'live'
  steps: SetupStep[]
  done: number
  total: number
  /** The first unmet step's key, or null when everything is done. */
  next: SetupStep['key'] | null
}

const isInstalled = (widget: WebChatLike | undefined): boolean =>
  !!widget?.publicKey && (widget.allowedDomains?.length ?? 0) > 0

/** The launch checklist, as the agent needs it: state plus the next move. */
export function deriveSetupStatus(input: SetupStatusInput): SetupStatus {
  const { settings } = input
  const widgets: WebChatLike[] = settings.channels?.webChat?.length
    ? settings.channels.webChat
    : settings.webChat
      ? [settings.webChat]
      : []
  const installed = widgets.some(isInstalled)
  const live =
    settings.enabled !== false &&
    widgets.some((widget) => isInstalled(widget) && widget.enabled)
  const hasAssistant = (settings.assistantProfiles?.length ?? 0) > 0

  const steps: SetupStep[] = [
    {
      key: 'bookable',
      done: input.meetingTypeCount > 0,
      action:
        'Create a meeting type with create_meeting_type — without one, nothing can be booked.',
    },
    {
      key: 'assistant',
      done: hasAssistant,
      action:
        'Run propose_conversion_setup on the company website, get the user’s explicit approval, then apply it with update_mira_settings.',
    },
    {
      key: 'knowledge',
      done: input.knowledgeDocumentCount > 0,
      action:
        'Crawl the company website with crawl_company_website so the assistant answers from their own pages.',
    },
    {
      key: 'testDrive',
      done: !!settings.lastTestDrive,
      action:
        'Run run_test_drive and show the user the verdicts — proof beats promises.',
    },
    {
      key: 'install',
      done: installed,
      action:
        'Add the website domain to webChat.allowedDomains via update_mira_settings, then give the user the snippet from get_mira_widget_embed.',
    },
    {
      key: 'live',
      done: live,
      action:
        'With the user’s approval, set webChat.enabled to true via update_mira_settings, then confirm with verify_widget_install.',
    },
  ]

  const done = steps.filter((step) => step.done).length
  return {
    stage: live ? 'live' : hasAssistant || installed ? 'ready' : 'fresh',
    steps,
    done,
    total: steps.length,
    next: steps.find((step) => !step.done)?.key ?? null,
  }
}

export interface InstallCheck {
  foundLoader: boolean
  foundKey: boolean
  installed: boolean
}

/**
 * Does this HTML actually serve the widget? The loader script is necessary;
 * the company's own key is what proves it is THEIR widget and not a snippet
 * copied from a blog post.
 */
export function analyzeInstallHtml(
  html: string,
  publicKey: string | null,
): InstallCheck {
  const foundLoader = /mira-widget(?:\.js|\?)/i.test(html)
  const foundKey = !!publicKey && html.includes(publicKey)
  return { foundLoader, foundKey, installed: foundLoader && foundKey }
}

/**
 * The plan facts an agent should know before it walks into a wall, shaped
 * from whatever `/user/me` exposes. Everything optional: an older API that
 * sends no featureAccess simply yields no plan block, never an error.
 */
export function planFromMe(me: unknown): Record<string, unknown> | null {
  const company = (me as { company?: Record<string, unknown> })?.company
  if (!company) return null
  const tier = company.tier ?? company.effectiveTier
  const access = company.featureAccess as Record<string, unknown> | undefined
  if (!tier && !access) return null
  return {
    ...(tier ? { tier } : {}),
    ...(typeof company.isInTrial === 'boolean'
      ? { trial: company.isInTrial }
      : {}),
    ...(access && typeof access.knowledgePageLimit === 'number'
      ? { knowledgePageLimit: access.knowledgePageLimit }
      : {}),
    ...(access && typeof access.maxWorkflows === 'number'
      ? { maxWorkflows: access.maxWorkflows }
      : {}),
    note: 'Plan limits gate individual actions, not this connection. Only mention upgrading when an action actually hits a limit.',
  }
}
