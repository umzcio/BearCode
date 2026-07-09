import { app, shell, session, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { bootResumeInterruptedRuns, registerIpc } from './ipc'
import { runDevSmoke } from './devSmoke'
import icon from '../../resources/icon.png?asset'

// F4: expose a CDP endpoint so BrowserManager can drive an embedded
// WebContentsView with Playwright connectOverCDP. Bound to loopback only.
export const REMOTE_DEBUG_PORT = 9333
app.commandLine.appendSwitch('remote-debugging-port', String(REMOTE_DEBUG_PORT))
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

// F4: the browser view attaches to the main window, so BrowserManager needs a
// handle to it. createWindow() stores it here; getMainWindow() exposes it.
let mainWindow: BrowserWindow | null = null
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

// `ready-to-show` re-fires on renderer reloads (e.g. a dev-server restart,
// same caveat as `runDevSmoke`'s own guard in devSmoke.ts); the crash-resume
// scan (risk 6) must only ever run once per process.
let bootResumeRan = false
function runBootResumeOnce(): void {
  if (bootResumeRan) return
  bootResumeRan = true
  void bootResumeInterruptedRuns().catch((err) => {
    console.error('[bearcode] bootResumeInterruptedRuns failed:', err)
  })
}

function createWindow(): void {
  // Use a local non-null handle inside this function; assigning through the
  // module-level `mainWindow` (nulled in the `closed` handler below) would lose
  // narrowing across these closures.
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#131313',
    titleBarStyle: 'hidden',
    // Keep the native traffic lights on the same line as the sidebar
    // chrome row (toggle + history arrows).
    trafficLightPosition: { x: 20, y: 22 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's built-in PDF viewer (used by the ideal-preview PDF lane's
      // data: iframe) only renders when plugins are enabled.
      plugins: true,
      // Live run tickers and streamed text must keep moving while the
      // window is unfocused or minimized.
      backgroundThrottling: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
    runBootResumeOnce()
    runDevSmoke(win)
  })

  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One instance only: the SQLite database and key vault live in userData and
// must never be shared by concurrent app processes.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.bearcode.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Voice input (E5): the composer mic uses getUserMedia, which Electron denies
  // unless main explicitly grants the 'media' permission. No 'media' permission
  // is configured elsewhere, so scope both handlers to 'media' only.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media')
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
