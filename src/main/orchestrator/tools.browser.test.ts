import { describe, it, expect, vi, beforeEach } from 'vitest'

// tools.ts reaches ../permissions -> ../db (electron/sqlite), ../settings
// (electron), and ../browser/manager (electron + playwright) at import time.
// Mock every electron-touching module so importing the module under test never
// opens a real database / launches a browser, and so the guard chain's
// mode/consent/policy decisions are observable. ../browser/guard is left LIVE
// (pure) so the real decision matrix is exercised end to end.
vi.mock('../permissions', () => ({
  evaluateCommandForConversation: vi.fn(() => 'run'),
  evaluateEditForConversation: vi.fn(() => 'run'),
  resolveConversationMode: vi.fn(() => 'accept-edits')
}))
vi.mock('../db', () => ({ appendOrReplaceEvent: vi.fn() }))
vi.mock('../artifacts/store', () => ({
  createPlanArtifact: vi.fn(),
  createWalkthroughArtifact: vi.fn(),
  approvePlanArtifact: vi.fn()
}))
vi.mock('../agentsDir', () => ({ loadAgentsContent: vi.fn(() => ({ rules: [], workflows: [] })) }))
vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({ browserEnabled: true, browserAllowlist: [], browserBlocklist: [] }))
}))
vi.mock('../browser/manager', () => ({
  browserManager: {
    start: vi.fn(async () => {}),
    navigate: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example' })),
    read: vi.fn(async () => 'PAGE TEXT HERE'),
    screenshot: vi.fn(async () => 'data:image/png;base64,AAAA'),
    stashScreenshot: vi.fn(),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 'eval-result')
  }
}))
// Only `interrupt` is stubbed; the rest of @langchain/langgraph stays live.
vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@langchain/langgraph')>()),
  interrupt: vi.fn()
}))

import { resolveConversationMode } from '../permissions'
import { getSettings } from '../settings'
import { browserManager } from '../browser/manager'
import { interrupt } from '@langchain/langgraph'
import type { RunSink } from '../sink'
import { buildTools, clearBrowserConsent, clearDeniedReplayPins, pinDeniedReplays } from './tools'

const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })

interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}
const browserTools = (): Record<string, InvokableTool> => {
  const tools = buildTools('/tmp', 'convo', makeSink(), 'group-1') as unknown as InvokableTool[]
  return Object.fromEntries(
    tools.filter((t) => t.name.startsWith('browser_')).map((t) => [t.name, t])
  )
}

beforeEach(() => {
  clearBrowserConsent()
  clearDeniedReplayPins('convo')
  vi.mocked(resolveConversationMode).mockReturnValue('accept-edits')
  vi.mocked(getSettings).mockReturnValue({
    browserEnabled: true,
    browserAllowlist: [],
    browserBlocklist: []
  } as unknown as ReturnType<typeof getSettings>)
  vi.mocked(interrupt).mockReset()
  vi.mocked(browserManager.start).mockClear()
  vi.mocked(browserManager.navigate).mockClear()
  vi.mocked(browserManager.read).mockClear()
  vi.mocked(browserManager.screenshot).mockClear()
  vi.mocked(browserManager.stashScreenshot).mockClear()
  vi.mocked(browserManager.click).mockClear()
  vi.mocked(browserManager.type).mockClear()
  vi.mocked(browserManager.evaluate).mockClear()
})

describe('browser_* tools registration', () => {
  it('appends all eight browser tools to buildTools', () => {
    const names = Object.keys(browserTools()).sort()
    expect(names).toEqual([
      'browser_click',
      'browser_evaluate',
      'browser_navigate',
      'browser_read',
      'browser_screenshot',
      'browser_scroll',
      'browser_type',
      'browser_wait'
    ])
  })
})

describe('reads run free (no interrupt, no mode/consent gate)', () => {
  it('browser_read returns the page text without interrupting', async () => {
    const out = await browserTools().browser_read.invoke({ mode: 'text' })
    expect(out).toBe('PAGE TEXT HERE')
    expect(browserManager.read).toHaveBeenCalledWith('text')
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('a read never interrupts, even in plan mode', async () => {
    vi.mocked(resolveConversationMode).mockReturnValue('plan')
    await browserTools().browser_read.invoke({})
    await browserTools().browser_screenshot.invoke({})
    await browserTools().browser_scroll.invoke({ direction: 'down' })
    await browserTools().browser_wait.invoke({})
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('browser_screenshot inlines the data URL for an id-less call (no stash key)', async () => {
    // With no toolCallId the manager can't be keyed, so the tool falls back to
    // inlining the data URL (the card still renders); the rarer residual flood
    // is accepted only for id-less providers.
    const out = await browserTools().browser_screenshot.invoke({})
    expect(out).toBe('data:image/png;base64,AAAA')
    expect(browserManager.stashScreenshot).not.toHaveBeenCalled()
  })

  it('browser_screenshot returns a short placeholder and stashes the image when keyed', async () => {
    const out = await browserTools().browser_screenshot.invoke({}, { toolCallId: 'tcShot' })
    // The base64 image never reaches the model — it gets a short confirmation.
    expect(out.startsWith('data:image/')).toBe(false)
    expect(out.toLowerCase()).toContain('screenshot')
    // The full data URL is stashed for graph.ts to splice into the card.
    expect(browserManager.stashScreenshot).toHaveBeenCalledWith(
      'tcShot',
      'data:image/png;base64,AAAA'
    )
  })
})

describe('L0 enable gate', () => {
  it('every browser tool refuses when the feature is disabled in Settings', async () => {
    vi.mocked(getSettings).mockReturnValue({
      browserEnabled: false,
      browserAllowlist: [],
      browserBlocklist: []
    } as unknown as ReturnType<typeof getSettings>)
    const out = await browserTools().browser_read.invoke({})
    expect(out).toBe('Browser tool is disabled in Settings — enable it and relaunch.')
    expect(browserManager.start).not.toHaveBeenCalled()
    expect(browserManager.read).not.toHaveBeenCalled()
  })
})

describe('mutations respect the permission mode (like run_command)', () => {
  it('browser_click in ask mode interrupts and returns a denial on {approved:false}', async () => {
    vi.mocked(resolveConversationMode).mockReturnValue('ask')
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const out = await browserTools().browser_click.invoke({ ref: 'e12' }, { toolCallId: 'tc1' })
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'browser',
      action: 'click e12',
      toolCallId: 'tc1'
    })
    expect(out).toBe('User denied this browser action.')
    expect(browserManager.click).not.toHaveBeenCalled()
  })

  it('browser_click proceeds on {approved:true}', async () => {
    vi.mocked(resolveConversationMode).mockReturnValue('ask')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    const out = await browserTools().browser_click.invoke({ ref: 'e12' }, { toolCallId: 'tc1' })
    expect(browserManager.click).toHaveBeenCalledWith('e12')
    expect(out).toContain('e12')
  })

  it('plan mode blocks a mutation (read-only) with no interrupt', async () => {
    vi.mocked(resolveConversationMode).mockReturnValue('plan')
    const out = await browserTools().browser_type.invoke({ ref: 'e5', text: 'hi' })
    expect(interrupt).not.toHaveBeenCalled()
    expect(browserManager.type).not.toHaveBeenCalled()
    expect(out.toLowerCase()).toContain('plan mode')
  })

  it('browser_evaluate is a gated mutation', async () => {
    vi.mocked(resolveConversationMode).mockReturnValue('plan')
    const out = await browserTools().browser_evaluate.invoke({ script: 'document.title' })
    expect(browserManager.evaluate).not.toHaveBeenCalled()
    expect(out.toLowerCase()).toContain('plan mode')
  })
})

describe('L2 domain policy on navigate', () => {
  it('a blocklisted origin returns a blocked string without navigating or interrupting', async () => {
    vi.mocked(getSettings).mockReturnValue({
      browserEnabled: true,
      browserAllowlist: [],
      browserBlocklist: ['https://evil.com']
    } as unknown as ReturnType<typeof getSettings>)
    const out = await browserTools().browser_navigate.invoke({ url: 'https://evil.com/x' })
    expect(out.toLowerCase()).toContain('block')
    expect(browserManager.navigate).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('a non-allowlisted origin (when an allowlist exists) prompts, and a denial refuses', async () => {
    vi.mocked(getSettings).mockReturnValue({
      browserEnabled: true,
      browserAllowlist: ['https://example.com'],
      browserBlocklist: []
    } as unknown as ReturnType<typeof getSettings>)
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const out = await browserTools().browser_navigate.invoke(
      { url: 'https://other.com/x' },
      { toolCallId: 'tc9' }
    )
    expect(interrupt).toHaveBeenCalled()
    expect(browserManager.navigate).not.toHaveBeenCalled()
    expect(out.toLowerCase()).toContain('denied')
  })
})

describe('denied-replay pin wins over a decision flip (like run_command)', () => {
  it('a pinned browser mutation is refused on replay without interrupting or acting', async () => {
    // The flip vector: auto mode + consent already granted (an approved sibling
    // in the same batch), so evaluateBrowserAction now returns 'allow' and the
    // folded-consent prompt is skipped — the denied click would replay straight
    // into browserManager.click without the pin.
    clearBrowserConsent()
    vi.mocked(resolveConversationMode).mockReturnValue('auto')
    pinDeniedReplays('convo', [{ toolCallId: 'tcClick', browserAction: 'click e12' }])
    const out = await browserTools().browser_click.invoke({ ref: 'e12' }, { toolCallId: 'tcClick' })
    expect(out).toBe('User denied this browser action.')
    expect(interrupt).not.toHaveBeenCalled()
    expect(browserManager.click).not.toHaveBeenCalled()
  })

  it('an id-less denied navigate is refused via the browser-action namespace on replay', async () => {
    // The navigate flip: the user adds the origin to the allowlist while the
    // prompt is parked, so originDecision now returns 'allow'; the id-less pin
    // (browserAction) must still refuse the replay.
    vi.mocked(getSettings).mockReturnValue({
      browserEnabled: true,
      browserAllowlist: ['https://other.com'],
      browserBlocklist: []
    } as unknown as ReturnType<typeof getSettings>)
    pinDeniedReplays('convo', [{ browserAction: 'navigate https://other.com/x' }])
    const out = await browserTools().browser_navigate.invoke({ url: 'https://other.com/x' })
    expect(out).toBe('User denied this browser action.')
    expect(interrupt).not.toHaveBeenCalled()
    expect(browserManager.navigate).not.toHaveBeenCalled()
  })
})

describe('L1 session consent (one prompt per conversation, folded into first navigate)', () => {
  it('prompts once on the first navigate and never re-prompts on a later navigate', async () => {
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    const nav = browserTools().browser_navigate
    await nav.invoke({ url: 'https://example.com/a' }, { toolCallId: 't1' })
    await nav.invoke({ url: 'https://example.com/b' }, { toolCallId: 't2' })
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(browserManager.navigate).toHaveBeenCalledTimes(2)
  })
})
