import type { BrowserWindow } from 'electron'

// F4: the main-window handle + CDP port, split OUT of index.ts into this tiny
// module (a type-only electron import, no runtime side-effects). index.ts is the
// app-bootstrap entry point — it runs app.commandLine.* at import time — so any
// module that imported it just to read the window (BrowserManager) dragged the
// whole bootstrap into its graph and broke every ipc test the moment ipc.ts
// began importing the browser manager. Consumers read the ref here instead;
// index.ts owns writing it.
export const REMOTE_DEBUG_PORT = 9333

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
