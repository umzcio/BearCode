import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, type WebContentsView } from 'electron'
import { REMOTE_DEBUG_PORT, setBrowserDebuggingEnabled, setMainWindow } from '../mainWindow'
import { chromiumInstalled } from './install'
import { BrowserManager } from './manager'

// Run with `npm run test:electron:browser`. This is a headed gate: it requires
// a graphical display, free loopback TCP port 9333, the project Electron
// binary, and Playwright Chromium (`npx playwright install chromium`). Missing
// prerequisites and assertion failures always exit nonzero.
type Bounds = { x: number; y: number; width: number; height: number }
type ManagerWithView = { view: WebContentsView | null }

class HarnessFailure extends Error {
  constructor(
    readonly assertion: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

const timeoutMs = 45_000
const cleanupWatchdogMs = 5_000
let manager: BrowserManager | null = null
let window: BrowserWindow | null = null
let exiting = false

app.commandLine.appendSwitch('remote-debugging-port', String(REMOTE_DEBUG_PORT))
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

async function check(name: string, assertion: () => void | Promise<void>): Promise<void> {
  try {
    await assertion()
  } catch (error) {
    throw new HarnessFailure(name, error)
  }
  console.log(`PASS ${name}`)
}

async function cleanup(): Promise<void> {
  try {
    await manager?.teardown()
  } finally {
    manager = null
    setBrowserDebuggingEnabled(false)
    setMainWindow(null)
    if (window && !window.isDestroyed()) window.destroy()
    window = null
  }
}

async function finish(code: number, failure?: HarnessFailure): Promise<void> {
  if (exiting) return
  exiting = true
  clearTimeout(timeout)
  const cleanupWatchdog = setTimeout(() => {
    if (failure) console.error(`FAIL ${failure.assertion}: ${failure.message}`)
    else console.error(`FAIL cleanup: exceeded ${cleanupWatchdogMs}ms`)
    app.exit(1)
  }, cleanupWatchdogMs)
  try {
    await cleanup()
  } catch (error) {
    if (!failure) failure = new HarnessFailure('cleanup', error)
    code = 1
  } finally {
    clearTimeout(cleanupWatchdog)
  }
  if (failure) console.error(`FAIL ${failure.assertion}: ${failure.message}`)
  app.exit(code)
}

async function run(): Promise<void> {
  await app.whenReady()
  if (!chromiumInstalled()) {
    throw new Error(
      'Playwright Chromium is not installed. Run `npx playwright install chromium` before this headed gate.'
    )
  }

  window = new BrowserWindow({
    width: 960,
    height: 720,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Harness host</title><main>Browser harness host</main>')}`
  )
  setMainWindow(window)
  setBrowserDebuggingEnabled(true)

  manager = new BrowserManager()
  const initialBounds: Bounds = { x: 32, y: 24, width: 640, height: 420 }
  const latestBounds: Bounds = { x: 48, y: 36, width: 720, height: 480 }
  manager.setBounds(initialBounds)
  await manager.start(`headed-harness-${randomUUID()}`)

  const view = (manager as unknown as ManagerWithView).view
  assert.ok(view, 'BrowserManager did not create a WebContentsView')

  await check('hidden bounds', () => {
    assert.deepEqual(view.getBounds(), {
      x: -10000,
      y: 0,
      width: initialBounds.width,
      height: initialBounds.height
    })
  })

  await check('show latest bounds', () => {
    manager!.show()
    assert.deepEqual(view.getBounds(), initialBounds)

    manager!.hide()
    manager!.setBounds(latestBounds)
    assert.deepEqual(view.getBounds(), {
      x: -10000,
      y: 0,
      width: latestBounds.width,
      height: latestBounds.height
    })

    manager!.show()
    assert.deepEqual(view.getBounds(), latestBounds)
  })

  await check('navigation/read', async () => {
    const expectedText = 'Deterministic headed browser content'
    const html = `<!doctype html><title>Harness page</title><main>${expectedText}</main>`
    const result = await manager!.navigate(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    )
    const nativeUrl = view.webContents.getURL()
    assert.equal(
      result.url,
      nativeUrl,
      'BrowserManager navigation result did not match the native view'
    )
    assert.match(await manager!.read('text'), new RegExp(expectedText))
  })

  await check('screenshot', async () => {
    const screenshot = await manager!.screenshot()
    assert.match(screenshot, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    assert.ok(screenshot.length > 1_000, 'PNG data URL was unexpectedly small')
  })

  await check('teardown destroys view', async () => {
    const childContents = view.webContents
    assert.equal(
      childContents.isDestroyed(),
      false,
      'child WebContents was destroyed before teardown'
    )
    const destroyed = new Promise<void>((resolve) => childContents.once('destroyed', resolve))
    await manager!.teardown()
    assert.equal(window!.contentView.children.includes(view), false)
    await destroyed
    assert.equal(childContents.isDestroyed(), true)
  })
}

const timeout = setTimeout(() => {
  void finish(1, new HarnessFailure('timeout', `exceeded ${timeoutMs}ms`))
}, timeoutMs)

void run()
  .then(() => finish(0))
  .catch((error: unknown) =>
    finish(1, error instanceof HarnessFailure ? error : new HarnessFailure('setup', error))
  )
