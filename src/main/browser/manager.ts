import { randomUUID } from 'crypto'
import { WebContentsView } from 'electron'
import { chromium, type Browser, type Page } from 'playwright'
import { getMainWindow, REMOTE_DEBUG_PORT, browserDebuggingEnabled } from '../mainWindow'
import { ensureChromium, chromiumInstalled } from './install'
import { indexOfPageWithToken, type DomainPolicy } from './policy'
import { navigationBlockedByPolicy } from './guard'
import type { BrowserPhase, BrowserStatus } from '../../shared/types'

// Playwright locator errors embed ANSI color codes and a long "Call log:" retry
// dump that render as unreadable noise ("[2m … [22m") in the tool error card.
// Strip the ANSI and keep only the first line (the actual failure) so the agent
// + the card get a clean message.
async function cleanPlaywrightError<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const firstLine = raw
      .split('\n')[0]
      .replace(/\[[0-9;]*m/g, '')
      .trim()
    throw new Error(firstLine || raw)
  }
}

type Bounds = { x: number; y: number; width: number; height: number }

function hiddenBounds(bounds: Bounds): Bounds {
  return { x: -10000, y: 0, width: bounds.width, height: bounds.height }
}

function sanitizedError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const firstLine = raw
    .split('\n')[0]
    .replace(/\[[0-9;]*m/g, '')
    .replaceAll(String.fromCharCode(27), '')
    .trim()
  return new Error(firstLine || 'The browser could not be started.')
}

class BrowserSessionSupersededError extends Error {
  constructor() {
    super('Browser start was superseded by a newer lifecycle request.')
  }
}

export class BrowserManager {
  private view: WebContentsView | null = null
  private browser: Browser | null = null
  private page: Page | null = null
  private convId: string | null = null
  private sessionGeneration = 0
  private teardownPromise: Promise<void> | null = null
  // Default OFF-SCREEN but non-zero-sized: an attached view must have a real
  // width/height or Playwright screenshots fail ("0 width"), yet it must not
  // paint over the app UI before the renderer pane reports its on-screen bounds.
  // The BrowserPane's ResizeObserver overrides this with real bounds on mount.
  private bounds: Bounds = { x: -10000, y: 0, width: 1280, height: 800 }
  // Requested renderer visibility is independent of whether a view currently
  // exists. Bounds may keep updating while hidden without exposing native
  // pixels or input above a moving DOM shell.
  private visible = false
  private phase: BrowserPhase = 'idle'
  private message: string | null = null
  private statusListeners = new Set<(status: BrowserStatus) => void>()
  // L2 domain policy provider (F4 finding 2). The tool layer wires this to the
  // live Settings-derived policy in tools.ts `buildBrowserTools` (which graph.ts
  // wires UNCONDITIONALLY — folder or not — so the provider is always installed),
  // so the navigation interceptor below always consults the current
  // allow/blocklist. Defaults to an EMPTY policy that blocks nothing — but the
  // interceptor is a hard gate only for what the policy names, and
  // buildBrowserTools sets the real provider before any browser tool can call
  // start(), so this default never governs a live session.
  private policyProvider: () => DomainPolicy = () => ({ allowlist: [], blocklist: [] })
  setPolicyProvider(provider: () => DomainPolicy): void {
    this.policyProvider = provider
  }

  status(): BrowserStatus {
    // debuggingEnabled = whether the CDP endpoint was opened at BOOT (finding 2).
    // It's read once at boot from the persisted setting, so it can diverge from
    // the live `browserEnabled` setting after the user toggles the feature —
    // the Settings UI compares the two to show a "relaunch required" note.
    return Object.freeze({
      phase: this.phase,
      message: this.message,
      installed: chromiumInstalled(),
      connected: !!this.page,
      conversationId: this.convId,
      debuggingEnabled: browserDebuggingEnabled()
    })
  }
  onStatus(listener: (status: BrowserStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }
  private transition(phase: BrowserPhase, message: string | null = null): void {
    if (this.phase === phase && this.message === message) return
    this.phase = phase
    this.message = message
    const snapshot = this.status()
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot)
      } catch {
        // A renderer/broadcast observer must never break lifecycle ownership or
        // prevent later observers from receiving the same immutable snapshot.
      }
    }
  }
  currentUrl(): string {
    return this.view?.webContents.getURL() ?? 'about:blank'
  }

  async start(conversationId: string): Promise<void> {
    if (this.phase === 'ready' && this.page && this.convId === conversationId) return
    await this.teardown()
    const generation = ++this.sessionGeneration
    try {
      // A new native view always starts hidden. The renderer must explicitly show
      // it again after receiving `ready`, so stale visibility from a prior session
      // can never expose native pixels over loading or error feedback.
      this.visible = false
      this.transition('starting')
      await ensureChromium()
      this.assertCurrentGeneration(generation)
      // finding 2: the CDP endpoint is only open when the feature was enabled at
      // boot. Fail with an actionable message rather than blindly dialling a port
      // that isn't ours (or isn't listening at all).
      if (!browserDebuggingEnabled()) {
        throw new Error(
          'The browser debugging endpoint is disabled. Enable Browser in Settings and relaunch BearCode.'
        )
      }
      const win = getMainWindow()
      if (!win) throw new Error('No main window to attach the browser view to.')
      this.assertCurrentGeneration(generation)
      this.convId = conversationId
      // finding 1: mint a unique per-session token and embed it in the view's
      // initial URL. resolvePage() selects the CDP page by this token, so it can
      // ONLY ever attach to our WebContentsView — never the app's own renderer,
      // another BearCode instance sharing the (silently-collided) port, or a
      // squatter's fake endpoint. Any of those yields no token match → we refuse.
      const token = randomUUID()
      this.view = new WebContentsView({
        webPreferences: { sandbox: true, partition: `browser:${conversationId}` }
      })
      win.contentView.addChildView(this.view)
      this.view.setBounds(hiddenBounds(this.bounds))
      await this.view.webContents.loadURL(
        `data:text/html,<!--bearcode-${token}--><title>bearcode</title>`
      )
      this.assertCurrentGeneration(generation)
      // A crashed renderer is not a normal stop: preserve an actionable error
      // after cleanup so the pane explains why its native pixels disappeared.
      this.view.webContents.on('render-process-gone', () => {
        void this.failSession('The browser view stopped unexpectedly. Start it again.', generation)
      })
      // L2 hard gate on EVERY navigation (F4 finding 2), not just the
      // browser_navigate tool: browser_evaluate setting location.href, an in-page
      // link click, and server 302 redirects all reach a new origin WITHOUT
      // passing the tool's L2 check. will-navigate covers renderer-initiated
      // navigations (links, location changes); will-redirect covers server
      // redirect hops. A blocklisted destination is cancelled outright; 'allow'
      // and 'prompt' origins pass (prompting/consent is the tool layer's job —
      // there is no way to raise an approval mid-navigation). Our own
      // page.goto in navigate() already cleared L2 at the tool, so re-checking it
      // here is at worst a no-op (it can only be allow/prompt, never block).
      const guardNavigation = (event: { preventDefault: () => void }, targetUrl: string): void => {
        if (navigationBlockedByPolicy(targetUrl, this.policyProvider())) event.preventDefault()
      }
      this.view.webContents.on('will-navigate', guardNavigation)
      this.view.webContents.on('will-redirect', guardNavigation)
      // F4 (whole-branch review, popup escape): v1 is single-tab. A visited page's
      // window.open()/target=_blank must NOT spawn a window outside the pane,
      // Playwright's control, and the domain policy — deny all popups outright.
      this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // finding 4: never leave a zombie view attached if connect/target-select
      // throws (port squatted, target list unsettled, CDP flake). The outer
      // failure path tears down the whole session before publishing its error.
      this.page = await this.connectAndResolve(token, generation)
      this.assertCurrentGeneration(generation)
      // finding 4: if Playwright disconnects mid-session, tear the session DOWN
      // (detach + destroy the view) rather than only nulling the page — otherwise
      // status() reports a stranded view against a dead connection. Registered
      // BEFORE the awaited emulateMedia loop below (polish review): if the
      // connection drops mid-loop, 'disconnected' must still reach a live handler.
      this.browser?.on('disconnected', () => {
        void this.failSession(
          'The browser connection closed unexpectedly. Start it again.',
          generation
        )
      })
      // THEME FIX (confirmed via probe): connectOverCDP applies Playwright's
      // default colorScheme:'light' emulation to EVERY attached page — including
      // BearCode's own renderer — which flips the app UI to light in System theme
      // (before=dark → afterStart=light → restored only on teardown). Clear the
      // media override on every attached page that is NOT our browser view so the
      // app's own theme is never touched. Best-effort: a theme cosmetic must never
      // break the session. The view page keeps Playwright's default (fine for the
      // browsed content).
      try {
        for (const ctx of this.browser?.contexts() ?? []) {
          for (const p of ctx.pages()) {
            if (p !== this.page) await p.emulateMedia({ colorScheme: null })
            this.assertCurrentGeneration(generation)
          }
        }
      } catch {
        // Theme reset is cosmetic, but cancellation is lifecycle control and
        // must escape this best-effort block rather than becoming stale ready.
        this.assertCurrentGeneration(generation)
      }
      this.assertCurrentGeneration(generation)
      this.transition('ready')
    } catch (error) {
      if (error instanceof BrowserSessionSupersededError || generation !== this.sessionGeneration) {
        throw error instanceof Error ? error : new BrowserSessionSupersededError()
      }
      const sanitized = sanitizedError(error)
      const failureGeneration = ++this.sessionGeneration
      await this.teardownSession()
      if (failureGeneration === this.sessionGeneration) {
        this.transition('error', sanitized.message)
      }
      throw sanitized
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) throw new BrowserSessionSupersededError()
  }

  private async failSession(message: string, generation: number): Promise<void> {
    if (generation !== this.sessionGeneration) return
    const failureGeneration = ++this.sessionGeneration
    const sanitized = sanitizedError(message)
    try {
      try {
        this.moveNativeOffscreen()
      } catch {
        // The view may already be dead. Cleanup still owns detachment/close and
        // the actionable lifecycle error must still reach observers.
      }
      await this.teardownSession()
    } catch {
      // teardownSession is defensive internally, but status publication remains
      // finally-safe if a future cleanup primitive can reject.
    } finally {
      if (failureGeneration === this.sessionGeneration) {
        this.transition('error', sanitized.message)
      }
    }
  }

  // Connect to the CDP endpoint and resolve our view's page, retrying ONCE
  // (design: "retries once then reports; never leaves a zombie view attached").
  private async connectAndResolve(token: string, generation: number): Promise<Page> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertCurrentGeneration(generation)
      let localBrowser: Browser | null = null
      try {
        localBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${REMOTE_DEBUG_PORT}`)
        this.assertCurrentGeneration(generation)
        const page = await this.resolvePage(localBrowser, token, generation)
        this.assertCurrentGeneration(generation)
        this.browser = localBrowser
        return page
      } catch (err) {
        const superseded =
          generation !== this.sessionGeneration || err instanceof BrowserSessionSupersededError
        if (localBrowser) {
          try {
            await localBrowser.close()
          } catch {
            /* failed/stale local handle is already gone */
          }
        }
        if (superseded) throw new BrowserSessionSupersededError()
        lastErr = err
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Could not attach Playwright to the browser view target.')
  }

  // SECURITY-CRITICAL: select the CDP page carrying our unique session token —
  // never positionally. No match → throw; we refuse to drive any other target
  // (the app's own renderer, another instance, a squatter, a stale zombie).
  private async resolvePage(browser: Browser, token: string, generation: number): Promise<Page> {
    this.assertCurrentGeneration(generation)
    const find = (): Page | null => {
      this.assertCurrentGeneration(generation)
      const pages = browser.contexts().flatMap((c) => c.pages())
      const idx = indexOfPageWithToken(
        pages.map((p) => p.url()),
        token
      )
      return idx >= 0 ? pages[idx] : null
    }
    let page = find()
    if (!page) {
      // The page object list may not have settled immediately after connect;
      // re-query once on the next tick.
      await new Promise((r) => setImmediate(r))
      this.assertCurrentGeneration(generation)
      page = find()
    }
    if (!page) {
      throw new Error(
        'Could not attach Playwright to the browser view (no CDP page matched this session token). Refusing to drive any other target.'
      )
    }
    return page
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('Browser is not running. Start it first.')
    return this.page
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = this.requirePage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return { url: page.url(), title: await page.title() }
  }
  async read(mode: 'text' | 'a11y' | 'html'): Promise<string> {
    const page = this.requirePage()
    if (mode === 'html') return (await page.content()).slice(0, 20000)
    if (mode === 'text') return (await page.locator('body').innerText()).slice(0, 20000)
    // a11y: an indexed, ref-addressable snapshot the agent can click/type by.
    // Playwright 1.61 removed page.accessibility.snapshot(); ariaSnapshot with
    // mode:'ai' returns exactly this — a compact tree tagged with `[ref=e<N>]`
    // handles that refLocator() maps back to `aria-ref=` locators.
    return (await page.locator('body').ariaSnapshot({ mode: 'ai' })).slice(0, 20000)
  }
  async screenshot(): Promise<string> {
    const buf = await this.requirePage().screenshot({ type: 'png' })
    return `data:image/png;base64,${buf.toString('base64')}`
  }
  async click(ref: string): Promise<void> {
    await cleanPlaywrightError(() => refLocator(this.requirePage(), ref).click({ timeout: 10000 }))
  }
  async type(ref: string, text: string, submit = false): Promise<void> {
    await cleanPlaywrightError(async () => {
      const loc = refLocator(this.requirePage(), ref)
      await loc.fill(text, { timeout: 10000 })
      if (submit) await loc.press('Enter')
    })
  }
  async scroll(dir: 'up' | 'down'): Promise<void> {
    await this.requirePage().mouse.wheel(0, dir === 'down' ? 600 : -600)
  }
  async waitFor(state: 'load' | 'networkidle'): Promise<void> {
    await this.requirePage().waitForLoadState(state)
  }
  async evaluate(js: string): Promise<string> {
    const out: unknown = await this.requirePage().evaluate(js)
    return typeof out === 'string' ? out : JSON.stringify(out)
  }

  // Out-of-band screenshot channel (finding: keep base64 out of the model's
  // context). browser_screenshot stashes the full data URL here keyed by the
  // provider tool-call id and returns a short placeholder to the model; the
  // drive loop (graph.ts) splices the stashed image into the PERSISTED
  // tool_result output so the step card renders the <img>. Bounded — a handful
  // of entries per conversation — and cleared on teardown.
  private screenshots = new Map<string, string>()
  stashScreenshot(toolCallId: string, dataUrl: string): void {
    this.screenshots.set(toolCallId, dataUrl)
  }
  // Non-consuming (live streaming emit) — the authoritative persist consumes.
  peekStashedScreenshot(toolCallId: string): string | undefined {
    return this.screenshots.get(toolCallId)
  }
  // Consuming take-once (authoritative persist), so a reused tool-call id can
  // never resurface a stale image.
  takeStashedScreenshot(toolCallId: string): string | undefined {
    const url = this.screenshots.get(toolCallId)
    this.screenshots.delete(toolCallId)
    return url
  }

  setBounds(b: Bounds): void {
    this.bounds = b
    this.view?.setBounds(this.visible ? b : hiddenBounds(b))
  }
  show(): void {
    if (this.phase !== 'ready' || !this.page) return
    this.visible = true
    this.view?.setBounds(this.bounds)
  }
  private moveNativeOffscreen(): void {
    this.visible = false
    this.view?.setBounds(hiddenBounds(this.bounds))
  }
  async hide(): Promise<void> {
    try {
      this.moveNativeOffscreen()
    } catch {
      const failure = new Error(
        'Could not safely hide the browser view. The browser session was closed.'
      )
      const failureGeneration = ++this.sessionGeneration
      try {
        await this.teardownSession()
      } finally {
        if (failureGeneration === this.sessionGeneration) {
          this.transition('error', failure.message)
        }
      }
      throw failure
    }
  }
  async clearSession(): Promise<void> {
    await this.view?.webContents.session.clearStorageData()
  }
  async teardown(): Promise<void> {
    const generation = ++this.sessionGeneration
    await this.teardownSession()
    if (generation === this.sessionGeneration) this.transition('idle')
  }
  private async teardownSession(): Promise<void> {
    // Re-entrancy guard: browser.close() below fires 'disconnected', whose
    // handler calls failSession() again. Every caller joins the same cleanup
    // promise; a replacement start cannot proceed while old native resources
    // are still closing.
    if (this.teardownPromise) return this.teardownPromise
    const cleanup = (async (): Promise<void> => {
      this.visible = false
      this.screenshots.clear()
      const browser = this.browser
      const view = this.view
      this.browser = null
      this.page = null
      this.view = null
      this.convId = null
      if (view) {
        const win = getMainWindow()
        try {
          win?.contentView.removeChildView(view)
        } catch {
          /* detached */
        }
        // finding 3: removeChildView only DETACHES — the webContents lives until
        // GC, leaking a renderer process and lingering as a CDP data-url target
        // the next start() could ambiguously attach to. Destroy it explicitly.
        try {
          view.webContents.close()
        } catch {
          /* already destroyed */
        }
      }
      try {
        await browser?.close()
      } catch {
        /* already gone */
      }
    })()
    this.teardownPromise = cleanup
    try {
      await cleanup
    } finally {
      if (this.teardownPromise === cleanup) this.teardownPromise = null
    }
  }
}

// Map an agent-supplied ref back to a Playwright locator.
//  - `e<N>`        → an ariaSnapshot({ mode:'ai' }) handle → `aria-ref=` locator.
//  - `role:name#i` → getByRole with an accessible-name filter (plan's format).
//  - anything else → treated as a raw selector (best-effort fallback).
function refLocator(page: Page, ref: string): ReturnType<Page['locator']> {
  if (/^e\d+$/i.test(ref)) return page.locator(`aria-ref=${ref}`)
  const m = /^([a-z]+):(.*)#(\d+)$/i.exec(ref)
  if (!m) return page.locator(ref)
  const [, role, name] = m
  return page.getByRole(role as Parameters<Page['getByRole']>[0], name ? { name } : undefined)
}

export const browserManager = new BrowserManager()
