import { WebContentsView } from 'electron'
import { chromium, type Browser, type Page } from 'playwright'
import { getMainWindow, REMOTE_DEBUG_PORT } from '../index'
import { ensureChromium, chromiumInstalled } from './install'
import { matchBrowserTarget, type CdpTarget } from './policy'

type Bounds = { x: number; y: number; width: number; height: number }

class BrowserManager {
  private view: WebContentsView | null = null
  private browser: Browser | null = null
  private page: Page | null = null
  private convId: string | null = null
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

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
    const win = getMainWindow()
    if (!win) throw new Error('No main window to attach the browser view to.')
    this.convId = conversationId
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, partition: `browser:${conversationId}` }
    })
    win.contentView.addChildView(this.view)
    this.view.setBounds(this.bounds)
    await this.view.webContents.loadURL('about:blank')
    // Connect Playwright to the app's CDP endpoint and select ONLY our view.
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${REMOTE_DEBUG_PORT}`)
    this.page = await this.resolvePage()
    // Recover if the view's renderer dies mid-session.
    this.view.webContents.on('render-process-gone', () => {
      void this.teardown()
    })
    this.browser.on('disconnected', () => {
      this.page = null
    })
  }

  // Match the CDP page target to our view's current URL (never the app renderer).
  private async resolvePage(): Promise<Page> {
    if (!this.browser || !this.view) throw new Error('Browser not started.')
    const viewUrl = this.view.webContents.getURL()
    for (const ctx of this.browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url() === viewUrl) return p
      }
    }
    // Fall back to CDP target list via the matcher (same-origin) if the page
    // object list hasn't settled; re-query pages after a microtask.
    await new Promise((r) => setImmediate(r))
    const pages = this.browser.contexts().flatMap((c) => c.pages())
    const targets: CdpTarget[] = pages.map((p, i) => ({
      url: p.url(),
      type: 'page',
      id: String(i)
    }))
    const match = matchBrowserTarget(targets, viewUrl)
    if (!match) throw new Error('Could not attach Playwright to the browser view target.')
    return pages[Number(match.id)]
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
    try {
      await this.browser?.close()
    } catch {
      /* already gone */
    }
    if (this.view) {
      const win = getMainWindow()
      try {
        win?.contentView.removeChildView(this.view)
      } catch {
        /* detached */
      }
    }
    this.view = null
    this.browser = null
    this.page = null
    this.convId = null
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
