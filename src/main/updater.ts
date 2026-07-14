import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '../shared/types'

// Startup check waits a few seconds so it never competes with initial
// app boot/render; periodic re-checks are spaced out since this is a
// background, low-urgency signal.
const STARTUP_DELAY_MS = 5000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let targetWindow: BrowserWindow | null = null
let currentStatus: UpdaterStatus = { state: 'idle' }
let initialized = false

function setStatus(status: UpdaterStatus): void {
  currentStatus = status
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send('bearcode:updater:status', status)
  }
}

// Called once from main/index.ts after the main window is created. No-ops
// in dev/unpackaged builds -- electron-updater has no signed artifact to
// compare against there, so a real check would only ever fail.
export function initUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return
  targetWindow = win
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info: { version: string }) =>
    setStatus({ state: 'downloading', version: info.version })
  )
  autoUpdater.on('update-not-available', () =>
    setStatus({ state: 'up-to-date', checkedAt: Date.now() })
  )
  autoUpdater.on('update-downloaded', (info: { version: string }) =>
    setStatus({ state: 'ready', version: info.version })
  )
  autoUpdater.on('error', (err: Error) => setStatus({ state: 'error', message: err.message }))

  setTimeout(() => void checkNow(), STARTUP_DELAY_MS)
  setInterval(() => void checkNow(), CHECK_INTERVAL_MS)
}

// Triggers a check. If one is already in flight (checking/downloading) or
// an update is already downloaded and waiting to install (ready), returns
// the current status instead of racing/clobbering it with a second
// autoUpdater.checkForUpdates() call. Without this, the periodic
// CHECK_INTERVAL_MS timer (or a repeated manual "Check for Updates" click)
// would silently reset an already-ready update back to 'checking' and
// restart the whole download -- observed live: polling checkNow() faster
// than a ~240MB download could complete kept resetting it before it ever
// got a full interval to finish. Resolves to the dev-build status
// immediately, without touching autoUpdater, when the app isn't packaged.
export async function checkNow(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { state: 'dev-build' }
  if (
    currentStatus.state === 'checking' ||
    currentStatus.state === 'downloading' ||
    currentStatus.state === 'ready'
  ) {
    return currentStatus
  }
  setStatus({ state: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return currentStatus
}

export function installNow(): void {
  autoUpdater.quitAndInstall()
}
