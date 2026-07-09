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

// F4 finding 2: whether the CDP remote-debugging endpoint was opened at boot.
// index.ts appends the `--remote-debugging-port` switch ONLY when the Browser
// feature is enabled in settings, and records that decision here. Opening the
// endpoint unconditionally would expose BearCode's OWN privileged renderer
// (window.bearcode IPC: run:start, worktree ops, file dialogs) to any same-user
// local process — even for users who never enable the browser. The value is
// read once at boot; enabling the feature therefore requires an app relaunch.
let browserDebugEnabled = false

export function setBrowserDebuggingEnabled(enabled: boolean): void {
  browserDebugEnabled = enabled
}

export function browserDebuggingEnabled(): boolean {
  return browserDebugEnabled
}
