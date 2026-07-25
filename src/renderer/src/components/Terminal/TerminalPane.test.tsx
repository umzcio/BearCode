// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { BearcodeApi } from '@shared/types'
import { useAppStore } from '../../state/store'
import { TerminalPane } from './TerminalPane'

const fakeTerm = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24
}
// vitest 4 requires constructor mocks to be actual functions/classes (an
// arrow function can't be invoked with `new`).
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function Terminal() {
    return fakeTerm
  })
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddon() {
    return { fit: vi.fn() }
  })
}))

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

const dataListeners: Array<(id: string, chunk: string) => void> = []
const exitListeners: Array<(id: string) => void> = []

// The store is a singleton; a test that overrides markTerminalTabExited would
// leak the mock into later tests, so capture the pristine action and restore
// it each time (mirrors ConflictResolver.test.tsx's showToast handling).
const realMarkTerminalTabExited = useAppStore.getState().markTerminalTabExited
const markExited = vi.fn()

beforeEach(() => {
  dataListeners.length = 0
  exitListeners.length = 0
  vi.clearAllMocks()
  useAppStore.setState({ markTerminalTabExited: markExited })
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    terminal: { write: vi.fn(), resize: vi.fn() },
    onTerminalData: (cb: (id: string, chunk: string) => void) => {
      dataListeners.push(cb)
      return () => {
        const i = dataListeners.indexOf(cb)
        if (i >= 0) dataListeners.splice(i, 1)
      }
    },
    onTerminalExit: (cb: (id: string) => void) => {
      exitListeners.push(cb)
      return () => {
        const i = exitListeners.indexOf(cb)
        if (i >= 0) exitListeners.splice(i, 1)
      }
    }
  } as unknown as BearcodeApi
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ markTerminalTabExited: realMarkTerminalTabExited })
})

describe('TerminalPane', () => {
  it("resizes on mount using the bridge with this pane's id", () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    expect(window.bearcode.terminal.resize).toHaveBeenCalledWith('t1', 80, 24)
  })

  it('writes an incoming chunk for its own id into the terminal instance', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    dataListeners[0]('t1', 'hello')
    expect(fakeTerm.write).toHaveBeenCalledWith('hello')
  })

  it('ignores a chunk addressed to a different id', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    dataListeners[0]('other', 'hello')
    expect(fakeTerm.write).not.toHaveBeenCalled()
  })

  it('marks the tab exited when its own exit event fires', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    exitListeners[0]('t1')
    expect(markExited).toHaveBeenCalledWith('/proj/a', 't1')
  })

  it('disposes the terminal and unsubscribes on unmount', () => {
    const { unmount } = render(<TerminalPane id="t1" path="/proj/a" active />)
    unmount()
    expect(fakeTerm.dispose).toHaveBeenCalled()
    expect(dataListeners).toHaveLength(0)
    expect(exitListeners).toHaveLength(0)
  })
})
