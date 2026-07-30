import type { BrowserWindow, IpcMainInvokeEvent, Rectangle } from 'electron'

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function assertBrowserControlSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  mainWindow: BrowserWindow | null
): asserts mainWindow is BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Browser control unavailable.')
  }
  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) {
    throw new Error('Browser control unavailable.')
  }
  const mainFrame = webContents.mainFrame
  if (!mainFrame || mainFrame.isDestroyed() || mainFrame.detached) {
    throw new Error('Browser control unavailable.')
  }
  if (event.sender !== webContents || event.senderFrame !== mainFrame) {
    throw new Error('Unauthorized browser control.')
  }
}

export function parseBrowserBounds(
  raw: unknown,
  contentBounds: Pick<Rectangle, 'width' | 'height'>
): BrowserBounds {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid browser bounds.')
  }

  const keys = ['x', 'y', 'width', 'height'] as const
  if (
    Object.keys(raw).length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(raw, key))
  ) {
    throw new Error('Invalid browser bounds.')
  }

  const candidate = raw as Record<(typeof keys)[number], unknown>
  const { x, y, width, height } = candidate
  if (
    !isSafeInteger(x) ||
    !isSafeInteger(y) ||
    !isSafeInteger(width) ||
    !isSafeInteger(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    width > contentBounds.width ||
    height > contentBounds.height ||
    x > contentBounds.width - width ||
    y > contentBounds.height - height
  ) {
    throw new Error('Invalid browser bounds.')
  }

  return { x, y, width, height }
}
