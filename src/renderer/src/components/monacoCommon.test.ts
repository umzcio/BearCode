// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('monaco-editor', () => ({
  Range: class {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number
    ) {}
  },
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    MouseTargetType: {
      GUTTER_GLYPH_MARGIN: 1,
      GUTTER_LINE_NUMBERS: 2
    }
  }
}))
vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({
  default: class EditorWorkerStub {}
}))

const { attachCommenting, monaco } = await import('./monacoCommon')

interface FakeZone {
  afterLineNumber: number
  heightInPx: number
  domNode: HTMLElement
}

function frameHarness(): {
  flushAt: (time: number) => void
  pending: () => number
} {
  let now = 0
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  return {
    flushAt: (time) => {
      now = time
      const queued = [...frames.values()]
      frames.clear()
      for (const callback of queued) callback(time)
    },
    pending: () => frames.size
  }
}

function fakeEditor(): {
  editor: Parameters<typeof attachCommenting>[0]
  container: HTMLDivElement
  zones: FakeZone[]
  layoutZone: ReturnType<typeof vi.fn>
  removeZone: ReturnType<typeof vi.fn>
  mouseDown: (line: number) => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const zones: FakeZone[] = []
  const layoutZone = vi.fn()
  const removeZone = vi.fn()
  let onMouseDown: ((event: never) => void) | undefined

  const editor = {
    getContainerDomNode: () => container,
    getBottomForLineNumber: (line: number) => line * 22,
    getTopForLineNumber: (line: number) => line * 22,
    getScrollTop: () => 0,
    createDecorationsCollection: () => ({ clear: vi.fn() }),
    changeViewZones: (
      callback: (accessor: {
        addZone: (zone: FakeZone) => string
        layoutZone: (id: string) => void
        removeZone: (id: string) => void
      }) => void
    ) => {
      callback({
        addZone: (zone) => {
          zones.push(zone)
          return `zone-${zones.length}`
        },
        layoutZone,
        removeZone
      })
    },
    onMouseDown: (callback: (event: never) => void) => {
      onMouseDown = callback
      return { dispose: vi.fn() }
    },
    onMouseMove: () => ({ dispose: vi.fn() }),
    onDidScrollChange: () => ({ dispose: vi.fn() })
  } as unknown as Parameters<typeof attachCommenting>[0]

  return {
    editor,
    container,
    zones,
    layoutZone,
    removeZone,
    mouseDown: (line) => {
      onMouseDown?.({
        target: {
          type: monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
          position: { lineNumber: line }
        }
      } as never)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.documentElement.style.setProperty('--dur-menu', '100ms')
  document.documentElement.style.setProperty('--ease-out', 'cubic-bezier(0, 0, 1, 1)')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-motion')
  document.body.replaceChildren()
})

describe('attachCommenting view-zone motion', () => {
  it('expands and collapses the zone before removing its structure', () => {
    const frames = frameHarness()
    const fake = fakeEditor()
    attachCommenting(fake.editor, vi.fn())

    fake.mouseDown(3)
    const zone = fake.zones[0]
    expect(zone.heightInPx).toBe(0)

    frames.flushAt(50)
    expect(zone.heightInPx).toBeGreaterThan(0)
    expect(zone.heightInPx).toBeLessThan(12)
    frames.flushAt(100)
    expect(zone.heightInPx).toBe(12)

    ;(fake.container.querySelector('.comment-bar-close') as HTMLButtonElement).click()
    expect(fake.removeZone).not.toHaveBeenCalled()
    frames.flushAt(150)
    expect(zone.heightInPx).toBeGreaterThan(0)
    frames.flushAt(200)
    expect(fake.removeZone).toHaveBeenCalledWith('zone-1')
    expect(fake.container.querySelector('.comment-zone-inline')).toBeNull()
  })

  it('retargets a closing zone when another composer opens', () => {
    const frames = frameHarness()
    const fake = fakeEditor()
    attachCommenting(fake.editor, vi.fn())

    fake.mouseDown(3)
    frames.flushAt(100)
    ;(fake.container.querySelector('.comment-bar-close') as HTMLButtonElement).click()
    frames.flushAt(150)
    const interruptedHeight = fake.zones[0].heightInPx

    fake.mouseDown(8)
    expect(fake.zones[1].heightInPx).toBeCloseTo(interruptedHeight, 4)
    frames.flushAt(250)

    expect(fake.zones[1].heightInPx).toBe(12)
    expect(fake.container.querySelector('.comment-zone-inline')).not.toBeNull()
  })

  it('snaps under reduced motion and cancels pending frames on dispose', () => {
    document.documentElement.setAttribute('data-motion', 'reduced')
    const frames = frameHarness()
    const fake = fakeEditor()
    const commenting = attachCommenting(fake.editor, vi.fn())

    fake.mouseDown(3)
    expect(fake.zones[0].heightInPx).toBe(12)
    expect(frames.pending()).toBe(0)

    commenting.dispose()
    expect(fake.removeZone).toHaveBeenCalledWith('zone-1')
    expect(fake.container.querySelector('.comment-zone-inline')).toBeNull()
  })
})
