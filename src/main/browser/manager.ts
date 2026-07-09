import { randomUUID } from 'crypto'
import { WebContentsView } from 'electron'
import { chromium, type Browser, type Page } from 'playwright'
import { getMainWindow, REMOTE_DEBUG_PORT, browserDebuggingEnabled } from '../mainWindow'
import { ensureChromium, chromiumInstalled } from './install'
import { indexOfPageWithToken } from './policy'

type Bounds = { x: number; y: number; width: number; height: number }

class BrowserManager {
  private view: WebContentsView | null = null
  private browser: Browser | null = null
  private page: Page | null = null
  private convId: string | null = null
  private tearingDown = false
  // Default OFF-SCREEN but non-zero-sized: an attached view must have a real
  // width/height or Playwright screenshots fail ("0 width"), yet it must not
  // paint over the app UI before the renderer pane reports its on-screen bounds.
  // The BrowserPane's ResizeObserver overrides this with real bounds on mount.
  private bounds: Bounds = { x: -10000, y: 0, width: 1280, height: 800 }

  status(): { installed: boolean; connected: boolean; conversationId: string | null } {
    return { installed: chromiumInstalled(), connected: !!this.page, conversationId: this.convId }
  }
  currentUrl(): string {
    return this.view?.webContents.getURL() ?? 'about:blank'
  }

  async start(conversationId: string): Promise<void> {
    if (this.page && this.convId === conversationId) return
    await this.teardown()
    await ensureChromium()
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
    this.view.setBounds(this.bounds)
    await this.view.webContents.loadURL(
      `data:text/html,<!--bearcode-${token}--><title>bearcode</title>`
    )
    // Recover if the view's renderer dies mid-session.
    this.view.webContents.on('render-process-gone', () => {
      void this.teardown()
    })
    // finding 4: never leave a zombie view attached if connect/target-select
    // throws (port squatted, target list unsettled, CDP flake). Tear the whole
    // session down and surface the error.
    try {
      this.page = await this.connectAndResolve(token)
    } catch (err) {
      await this.teardown()
      throw err instanceof Error ? err : new Error(String(err))
    }
    // finding 4: if Playwright disconnects mid-session, tear the session DOWN
    // (detach + destroy the view) rather than only nulling the page — otherwise
    // status() reports a stranded view against a dead connection.
    this.browser?.on('disconnected', () => {
      void this.teardown()
    })
  }

  // Connect to the CDP endpoint and resolve our view's page, retrying ONCE
  // (design: "retries once then reports; never leaves a zombie view attached").
  private async connectAndResolve(token: string): Promise<Page> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Discard a browser handle left over from a failed prior attempt.
        try {
          await this.browser?.close()
        } catch {
          /* already gone */
        }
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${REMOTE_DEBUG_PORT}`)
        return await this.resolvePage(token)
      } catch (err) {
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
  private async resolvePage(token: string): Promise<Page> {
    if (!this.browser) throw new Error('Browser not started.')
    const find = (): Page | null => {
      const pages = this.browser!.contexts().flatMap((c) => c.pages())
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
    await refLocator(this.requirePage(), ref).click({ timeout: 10000 })
  }
  async type(ref: string, text: string, submit = false): Promise<void> {
    const loc = refLocator(this.requirePage(), ref)
    await loc.fill(text, { timeout: 10000 })
    if (submit) await loc.press('Enter')
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
    this.view?.setBounds(b)
  }
  show(): void {
    this.view?.setBounds(this.bounds)
  }
  hide(): void {
    this.view?.setBounds({ x: -10000, y: 0, width: this.bounds.width, height: this.bounds.height })
  }
  async clearSession(): Promise<void> {
    await this.view?.webContents.session.clearStorageData()
  }
  async teardown(): Promise<void> {
    // Re-entrancy guard: browser.close() below fires 'disconnected', whose
    // handler calls teardown() again; the view's 'render-process-gone' can also
    // land here concurrently. Null the refs up front and bail on re-entry.
    if (this.tearingDown) return
    this.tearingDown = true
    this.screenshots.clear()
    try {
      const browser = this.browser
      const view = this.view
      this.browser = null
      this.page = null
      this.view = null
      this.convId = null
      try {
        await browser?.close()
      } catch {
        /* already gone */
      }
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
    } finally {
      this.tearingDown = false
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
