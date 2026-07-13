// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BearcodeApi, UpdaterStatus } from '@shared/types'
import { useAppStore } from './store'

let statusListener: ((status: UpdaterStatus) => void) | null = null

const bearcodeMock = {
  app: { getVersion: vi.fn(() => Promise.resolve('1.0.0')) },
  updater: {
    checkNow: vi.fn(() => Promise.resolve({ state: 'up-to-date', checkedAt: 1 } as UpdaterStatus)),
    installNow: vi.fn()
  },
  onUpdaterStatus: vi.fn((cb: (status: UpdaterStatus) => void) => {
    statusListener = cb
    return () => {
      statusListener = null
    }
  }),
  onEvent: vi.fn(),
  onRunStateChange: vi.fn(),
  onConversationMeta: vi.fn(),
  settings: { get: vi.fn(() => Promise.resolve(null)) },
  conversations: { list: vi.fn(() => Promise.resolve([])) },
  history: { search: vi.fn(() => Promise.resolve([])) }
}

beforeEach(() => {
  vi.clearAllMocks()
  statusListener = null
  vi.stubGlobal('window', { bearcode: bearcodeMock as unknown as BearcodeApi })
  useAppStore.setState({
    appVersion: null,
    updaterStatus: { state: 'idle' },
    updateBannerDismissed: false
  } as never)
})

describe('updater store slice', () => {
  it('checkForUpdates calls window.bearcode.updater.checkNow and stores the result', async () => {
    await useAppStore.getState().checkForUpdates()
    expect(bearcodeMock.updater.checkNow).toHaveBeenCalled()
    expect(useAppStore.getState().updaterStatus).toEqual({ state: 'up-to-date', checkedAt: 1 })
  })

  it('installUpdate calls window.bearcode.updater.installNow', () => {
    useAppStore.getState().installUpdate()
    expect(bearcodeMock.updater.installNow).toHaveBeenCalled()
  })

  it('dismissUpdateBanner sets updateBannerDismissed', () => {
    useAppStore.getState().dismissUpdateBanner()
    expect(useAppStore.getState().updateBannerDismissed).toBe(true)
  })
})
