import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: class {} }))
vi.mock('../mainWindow', () => ({
  getMainWindow: () => null,
  REMOTE_DEBUG_PORT: 9333,
  browserDebuggingEnabled: () => true
}))
vi.mock('./install', () => ({
  ensureChromium: async (): Promise<void> => {},
  chromiumInstalled: (): boolean => false
}))

const { BrowserManager } = await import('./manager')

type Bounds = { x: number; y: number; width: number; height: number }

function managerWithView(): {
  manager: InstanceType<typeof BrowserManager>
  setBounds: ReturnType<typeof vi.fn<(bounds: Bounds) => void>>
} {
  const manager = new BrowserManager()
  const setBounds = vi.fn<(bounds: Bounds) => void>()
  ;(
    manager as unknown as {
      view: { setBounds: (bounds: Bounds) => void } | null
    }
  ).view = { setBounds }
  return { manager, setBounds }
}

describe('BrowserManager native-view visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores reported bounds without revealing a hidden view', () => {
    const { manager, setBounds } = managerWithView()

    manager.setBounds({ x: 40, y: 20, width: 900, height: 700 })

    expect(setBounds).toHaveBeenLastCalledWith({
      x: -10000,
      y: 0,
      width: 900,
      height: 700
    })
  })

  it('shows at the latest stored bounds and hides offscreen', () => {
    const { manager, setBounds } = managerWithView()
    const bounds = { x: 40, y: 20, width: 900, height: 700 }

    manager.setBounds(bounds)
    manager.show()
    expect(setBounds).toHaveBeenLastCalledWith(bounds)

    manager.hide()
    expect(setBounds).toHaveBeenLastCalledWith({
      x: -10000,
      y: 0,
      width: 900,
      height: 700
    })
  })

  it('keeps resizing hidden views offscreen until the next show', () => {
    const { manager, setBounds } = managerWithView()
    manager.show()
    manager.hide()

    const latest = { x: 60, y: 30, width: 1024, height: 768 }
    manager.setBounds(latest)

    expect(setBounds).toHaveBeenLastCalledWith({
      x: -10000,
      y: 0,
      width: 1024,
      height: 768
    })

    manager.show()
    expect(setBounds).toHaveBeenLastCalledWith(latest)
  })
})
