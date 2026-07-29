// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import type { BearcodeApi, Event, FileDiff } from '@shared/types'
import { mergeConvoEvent, useAppStore, type Convo } from '../state/store'
import { projectAuxEvents } from '../lib/auxEvents'
import { ArtifactsPane } from './ArtifactsPane'

vi.mock('./MonacoCode', () => ({
  default: ({
    value,
    language = 'plaintext',
    commentedLines = [],
    onAddComment
  }: {
    value: string
    language?: string
    commentedLines?: number[]
    onAddComment?: (line: number, text: string) => void
  }) => {
    const isImage = value.includes('PNG')
    const line = isImage ? 12 : 7
    const text = isImage ? 'Check image export' : 'Check the answer'
    return (
      <section
        data-testid="monaco-code-stub"
        data-language={language}
        data-commented-lines={commentedLines.join(',')}
      >
        <pre>{value}</pre>
        <textarea aria-label="Monaco input" />
        <button onClick={() => onAddComment?.(line, text)}>Add comment at line {line}</button>
      </section>
    )
  }
}))

vi.mock('./MonacoDiff', () => ({
  default: ({
    original,
    modified,
    language = 'plaintext',
    commentedLines = [],
    onAddComment
  }: {
    original: string
    modified: string
    language?: string
    commentedLines?: number[]
    onAddComment?: (line: number, text: string) => void
  }) => (
    <section
      data-testid="monaco-diff-stub"
      data-language={language}
      data-commented-lines={commentedLines.join(',')}
    >
      <pre>{original}</pre>
      <pre>{modified}</pre>
      <textarea aria-label="Monaco input" />
      <button onClick={() => onAddComment?.(7, 'Check the answer')}>Add comment at line 7</button>
    </section>
  )
}))

vi.mock('./FilePreview/FilePreview', () => ({
  FilePreview: ({ fileId }: { fileId: string }) => (
    <div data-testid="file-preview-stub">Previewing {fileId}</div>
  )
}))

const getDiff = vi.fn()
const revertDiff = vi.fn()
const openDiff = vi.fn()
const previewFile = vi.fn()
const writeClipboard = vi.fn()
const openFile = vi.fn()
const readFile = vi.fn()
const showToast = vi.fn()
const sendReview = vi.fn()

const diff: FileDiff = {
  diffId: 'diff_123',
  files: [
    {
      fileId: 'file_typescript',
      path: '/workspace/src/answer.ts',
      status: 'modified',
      beforeText: 'export const answer = 41\n',
      afterText: 'export const answer = 42\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    },
    {
      fileId: 'file_png',
      path: '/workspace/assets/diagram.png',
      status: 'created',
      beforeText: '',
      afterText: '(binary PNG bytes)',
      additions: 1,
      deletions: 0,
      state: 'applied'
    }
  ]
}

const secondDiff: FileDiff = {
  diffId: 'diff_456',
  files: [
    {
      fileId: 'file_second',
      path: '/workspace/src/second.ts',
      status: 'modified',
      beforeText: 'export const second = 1\n',
      afterText: 'export const second = 2\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    }
  ]
}

const sharedPathFirstDiff: FileDiff = {
  diffId: 'diff_shared_first',
  files: [
    {
      fileId: 'file_shared_first',
      path: '/workspace/src/shared.ts',
      status: 'modified',
      beforeText: 'export const shared = 1\n',
      afterText: 'export const shared = 2\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    }
  ]
}

const sharedPathSecondDiff: FileDiff = {
  diffId: 'diff_shared_second',
  files: [
    {
      fileId: 'file_unrelated_second',
      path: '/workspace/src/unrelated.ts',
      status: 'modified',
      beforeText: 'export const unrelated = 1\n',
      afterText: 'export const unrelated = 2\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    },
    {
      fileId: 'file_shared_second',
      path: '/workspace/src/shared.ts',
      status: 'modified',
      beforeText: 'export const shared = 2\n',
      afterText: 'export const shared = 3\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    }
  ]
}

const emptyDiff: FileDiff = { diffId: 'diff_empty', files: [] }

const classificationDiff: FileDiff = {
  diffId: 'diff_classification',
  files: [
    {
      fileId: 'file_ruby',
      path: '/workspace/lib/task.rb',
      status: 'modified',
      beforeText: 'puts :before\n',
      afterText: 'puts :after\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    },
    {
      fileId: 'file_go',
      path: '/workspace/cmd/main.go',
      status: 'modified',
      beforeText: 'package main\n',
      afterText: 'package main\n',
      additions: 0,
      deletions: 0,
      state: 'applied'
    },
    {
      fileId: 'file_rust',
      path: '/workspace/src/lib.rs',
      status: 'modified',
      beforeText: 'fn before() {}\n',
      afterText: 'fn after() {}\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    },
    {
      fileId: 'file_svg',
      path: '/workspace/assets/icon.svg',
      status: 'created',
      beforeText: '',
      afterText: '<svg />',
      additions: 1,
      deletions: 0,
      state: 'applied'
    },
    {
      fileId: 'file_html',
      path: '/workspace/pages/index.html',
      status: 'created',
      beforeText: '',
      afterText: '<main>after</main>',
      additions: 1,
      deletions: 0,
      state: 'applied'
    },
    {
      fileId: 'file_markdown',
      path: '/workspace/docs/notes.md',
      status: 'created',
      beforeText: '',
      afterText: '# after',
      additions: 1,
      deletions: 0,
      state: 'applied'
    }
  ]
}

function conversation(id: string, events: Event[]): Convo {
  return {
    id,
    projectPath: '/workspace',
    projectLabel: 'Workspace',
    title: 'Review changes',
    modelRef: null,
    permissionMode: 'accept-edits',
    effort: 'adaptive',
    thinking: true,
    webSearch: false,
    ursaMode: 'code',
    hermesMode: 'native',
    projectId: null,
    pinned: false,
    archived: false,
    updatedAt: 1,
    createdAt: 1,
    loaded: true,
    events,
    auxEvents: projectAuxEvents(events),
    runState: 'idle',
    environment: 'local',
    worktrees: []
  }
}

function seedDiffReview(
  selectedDiff: FileDiff = diff,
  focusPath: string | null = null,
  diffs: FileDiff[] = [selectedDiff]
): void {
  useAppStore.setState({
    view: { kind: 'conversation', id: 'conv_123' },
    conversations: {
      conv_123: conversation('conv_123', [
        { type: 'user_message', id: 'event_prompt', text: 'Please add the answer and diagram.' },
        ...diffs.map((fileDiff, index) => ({
          type: 'file_diff' as const,
          id: `event_diff_${index}`,
          diffId: fileDiff.diffId,
          files: fileDiff.files.map(({ path, additions, deletions, status }) => ({
            path,
            additions,
            deletions,
            status
          }))
        }))
      ])
    },
    auxSelection: { kind: 'diff', diffId: selectedDiff.diffId },
    auxPaneOpenTick: 0,
    auxPaneWidth: 560,
    reviewFocusPath: focusPath,
    diffReviewComments: {},
    diffReviewSending: {},
    send: sendReview,
    showToast
  } as never)
}

function seedFileReview(path: string, conversationId = 'conv_123'): void {
  useAppStore.setState({
    view: { kind: 'conversation', id: conversationId },
    conversations: {
      [conversationId]: conversation(conversationId, [])
    },
    auxSelection: { kind: 'file', path },
    auxPaneOpenTick: 0,
    auxPaneWidth: 560,
    reviewFocusPath: null,
    showToast
  } as never)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  return {
    promise: new Promise<T>((finish, fail) => {
      resolve = finish
      reject = fail
    }),
    resolve,
    reject
  }
}

let storeBefore = useAppStore.getState()
let bearcodeBefore: PropertyDescriptor | undefined

beforeEach(() => {
  storeBefore = useAppStore.getState()
  bearcodeBefore = Object.getOwnPropertyDescriptor(window, 'bearcode')
  getDiff.mockReset()
  getDiff.mockResolvedValue(diff)
  revertDiff.mockReset()
  revertDiff.mockResolvedValue(undefined)
  openDiff.mockReset()
  openDiff.mockResolvedValue(undefined)
  previewFile.mockReset()
  previewFile.mockResolvedValue({ kind: 'image', dataUrl: 'data:image/png;base64,AA==' })
  writeClipboard.mockReset()
  writeClipboard.mockResolvedValue(undefined)
  openFile.mockReset()
  openFile.mockResolvedValue(undefined)
  readFile.mockReset()
  readFile.mockResolvedValue('')
  showToast.mockReset()
  sendReview.mockReset()
  sendReview.mockResolvedValue(true)
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    diffs: { get: getDiff, revert: revertDiff, open: openDiff, previewFile },
    clipboard: { write: writeClipboard },
    shell: { openFile, readFile }
  } as unknown as BearcodeApi
})

afterEach(() => {
  cleanup()
  if (bearcodeBefore) Object.defineProperty(window, 'bearcode', bearcodeBefore)
  else Reflect.deleteProperty(window, 'bearcode')
  vi.unstubAllGlobals()
  useAppStore.setState(storeBefore, true)
})

describe('ArtifactsPane diff review', () => {
  it('skips assistant text stream renders but rerenders for new diff and artifact events', async () => {
    seedDiffReview()
    const onRender = vi.fn()
    render(
      <Profiler id="artifacts-pane" onRender={onRender}>
        <ArtifactsPane />
      </Profiler>
    )
    await screen.findByTestId('monaco-diff-stub')
    onRender.mockClear()

    act(() => {
      useAppStore.setState((state) => {
        const current = state.conversations.conv_123
        return {
          conversations: {
            ...state.conversations,
            conv_123: mergeConvoEvent(current, {
              type: 'assistant_text',
              id: 'text-stream',
              text: 'Still working'
            })
          }
        }
      })
    })

    expect(onRender).not.toHaveBeenCalled()

    act(() => {
      useAppStore.setState((state) => {
        const current = state.conversations.conv_123
        return {
          conversations: {
            ...state.conversations,
            conv_123: mergeConvoEvent(current, {
              type: 'file_diff',
              id: 'event-diff-new',
              diffId: 'diff_456',
              files: [
                { path: '/workspace/src/second.ts', additions: 1, deletions: 1, status: 'modified' }
              ]
            })
          }
        }
      })
    })

    expect(onRender).toHaveBeenCalled()
    expect(screen.getAllByRole('tab', { name: /Changes/ })).toHaveLength(2)
    onRender.mockClear()

    act(() => {
      useAppStore.setState((state) => {
        const current = state.conversations.conv_123
        return {
          conversations: {
            ...state.conversations,
            conv_123: mergeConvoEvent(current, {
              type: 'artifact',
              id: 'event-plan-new',
              artifactId: 'plan-new',
              artifactType: 'plan',
              version: 1,
              title: 'Plan',
              status: 'pending-review',
              body: '# Plan'
            })
          }
        }
      })
    })

    expect(onRender).toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: /Plan v1/ })).toBeInTheDocument()
  })

  it('keeps the diff pane loading until its requested diff resolves', async () => {
    const pending = deferred<FileDiff>()
    getDiff.mockReturnValueOnce(pending.promise)
    seedDiffReview()

    render(<ArtifactsPane />)

    expect(screen.getByText('Loading changes…')).toBeInTheDocument()
    expect(screen.queryByTestId('monaco-diff-stub')).toBeNull()

    await act(async () => {
      pending.resolve(diff)
    })
    expect(await screen.findByTestId('monaco-diff-stub')).toBeInTheDocument()
  })

  it('replaces loading with an accessible error when diff loading rejects', async () => {
    getDiff.mockRejectedValueOnce(new Error('IPC unavailable'))
    seedDiffReview()

    render(<ArtifactsPane />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load changes')
    expect(screen.queryByText('Loading changes…')).toBeNull()
    expect(screen.queryByText('No changes')).toBeNull()
  })

  it('applies a pre-load focus request after its diff resolves', async () => {
    const pending = deferred<FileDiff>()
    getDiff.mockReturnValueOnce(pending.promise)
    seedDiffReview(diff, '/workspace/assets/diagram.png')

    render(<ArtifactsPane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))

    await act(async () => {
      pending.resolve(diff)
    })

    expect(screen.getByRole('tab', { name: 'Diff · 2' })).toHaveClass('active')
    expect(screen.getByRole('tab', { name: /diagram\.png/ })).toHaveClass('active')
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_png')
  })

  it('consumes an unknown focus path and falls back to the first file', async () => {
    const pending = deferred<FileDiff>()
    getDiff.mockReturnValueOnce(pending.promise)
    seedDiffReview(diff, '/workspace/src/missing.ts')

    render(<ArtifactsPane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))

    await act(async () => {
      pending.resolve(diff)
    })

    expect(screen.getByRole('tab', { name: 'Diff · 2' })).toHaveClass('active')
    expect(screen.getByRole('tab', { name: /answer\.ts/ })).toHaveClass('active')
    expect(screen.getByTestId('monaco-diff-stub')).toBeInTheDocument()
  })

  it('reapplies a repeated file deep-link after the user manually selects another file', async () => {
    seedDiffReview(diff, '/workspace/src/answer.ts')
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('tab', { name: /diagram\.png/ }))
    expect(screen.getByRole('tab', { name: /diagram\.png/ })).toHaveClass('active')

    act(() => {
      useAppStore.getState().openReviewForFile('conv_123', '/workspace/src/answer.ts')
    })

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /answer\.ts/ })).toHaveClass('active')
    )
  })

  it('applies the same focus path again when a new deep-link targets a different diff', async () => {
    getDiff.mockImplementation((id: string) =>
      Promise.resolve(
        id === sharedPathFirstDiff.diffId ? sharedPathFirstDiff : sharedPathSecondDiff
      )
    )
    seedDiffReview(sharedPathFirstDiff, '/workspace/src/shared.ts', [
      sharedPathFirstDiff,
      sharedPathSecondDiff
    ])
    render(<ArtifactsPane />)
    await screen.findByText('export const shared = 2')

    act(() => {
      useAppStore.setState((state) => ({
        auxSelection: { kind: 'diff', diffId: sharedPathSecondDiff.diffId },
        reviewFocusPath: '/workspace/src/shared.ts',
        auxPaneOpenTick: state.auxPaneOpenTick + 1
      }))
    })

    await screen.findByText('export const shared = 3')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /shared\.ts/ })).toHaveClass('active')
    )
    expect(screen.getByRole('tab', { name: /unrelated\.ts/ })).not.toHaveClass('active')
  })

  it('ignores an older diff response after selection changes', async () => {
    const oldRequest = deferred<FileDiff>()
    const newRequest = deferred<FileDiff>()
    getDiff.mockImplementation((id: string) =>
      id === diff.diffId ? oldRequest.promise : newRequest.promise
    )
    seedDiffReview(diff, null, [diff, secondDiff])

    render(<ArtifactsPane />)

    fireEvent.click(
      screen
        .getAllByRole('tab', { name: /Changes/ })
        .find((button) => button.textContent?.includes('1 file'))!
    )
    await act(async () => {
      newRequest.resolve(secondDiff)
    })
    expect(await screen.findByText('export const second = 2')).toBeInTheDocument()

    await act(async () => {
      oldRequest.resolve(diff)
    })
    expect(screen.getByText('export const second = 2')).toBeInTheDocument()
    expect(screen.queryByText('export const answer = 42')).toBeNull()
  })

  it('shows No changes only after a successfully resolved empty diff', async () => {
    getDiff.mockResolvedValueOnce(emptyDiff)
    seedDiffReview(emptyDiff)

    render(<ArtifactsPane />)

    expect(await screen.findByText('No changes')).toBeInTheDocument()
    expect(screen.queryByText('Loading changes…')).toBeNull()
  })

  it('opens the first code file in the TypeScript diff view after loading', async () => {
    seedDiffReview()

    render(<ArtifactsPane />)

    const editor = await screen.findByTestId('monaco-diff-stub')
    expect(getDiff).toHaveBeenCalledWith('diff_123')
    expect(editor).toHaveAttribute('data-language', 'typescript')
    expect(editor).toHaveTextContent('export const answer = 41')
    expect(editor).toHaveTextContent('export const answer = 42')
    expect(screen.getByRole('tab', { name: /answer\.ts/ })).toHaveClass('active')
  })

  it('shows the originating prompt and every changed file in Overview', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))

    expect(screen.getByText('Please add the answer and diagram.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /answer\.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /diagram\.png/ })).toBeInTheDocument()
  })

  it('returns from an Overview row to Diff mode on that exact file', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))

    expect(screen.getByRole('tab', { name: /diagram\.png/ })).toHaveClass('active')
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_png')
  })

  it('switches file tabs and defaults code to Diff while PNG defaults to Preview', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    expect(await screen.findByTestId('monaco-diff-stub')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /diagram\.png/ }))
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_png')

    fireEvent.click(screen.getByRole('tab', { name: /answer\.ts/ }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-language', 'typescript')
  })

  it('exposes local automatically activated tablists without stealing Monaco arrow keys', async () => {
    seedDiffReview(diff, null, [diff, secondDiff])
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    const rail = screen.getByRole('tablist', { name: 'Artifacts' })
    const reviewMode = screen.getByRole('tablist', { name: 'Review mode' })
    const fileTabs = screen.getByRole('tablist', { name: 'Changed files' })
    const fileView = screen.getByRole('tablist', { name: 'File view' })
    const changes = within(rail).getAllByRole('tab', { name: /Changes/ })
    const overview = within(reviewMode).getByRole('tab', { name: 'Overview' })
    const diffMode = within(reviewMode).getByRole('tab', { name: 'Diff · 2' })
    const answer = within(fileTabs).getByRole('tab', { name: /answer\.ts/ })
    const diagram = within(fileTabs).getByRole('tab', { name: /diagram\.png/ })
    const diffView = within(fileView).getByRole('tab', { name: 'Diff' })

    expect(changes[1]).toHaveAttribute('aria-selected', 'true')
    expect(changes[1]).toHaveAttribute('tabindex', '0')
    expect(changes[0]).toHaveAttribute('tabindex', '-1')
    expect(diffMode).toHaveAttribute('aria-selected', 'true')
    expect(diffMode).toHaveAttribute('tabindex', '0')
    expect(overview).toHaveAttribute('tabindex', '-1')
    expect(answer).toHaveAttribute('aria-selected', 'true')
    expect(answer).toHaveAttribute('tabindex', '0')
    expect(diagram).toHaveAttribute('tabindex', '-1')
    expect(diffView).toHaveAttribute('aria-selected', 'true')
    expect(diffView).toHaveAttribute('tabindex', '0')

    for (const tablist of [rail, reviewMode, fileTabs, fileView]) {
      const tabs = within(tablist).getAllByRole('tab')
      for (const tab of tabs) {
        expect(tab).toHaveAttribute('id')
        const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '')
        expect(panel).toHaveAttribute('role', 'tabpanel')
      }
      const selectedTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')!
      const selectedPanel = document.getElementById(selectedTab.getAttribute('aria-controls')!)!
      expect(selectedPanel).toHaveAttribute('aria-labelledby', selectedTab.id)
    }

    fireEvent.keyDown(diffMode, { key: 'ArrowRight' })
    expect(overview).toHaveFocus()
    expect(overview).toHaveAttribute('aria-selected', 'true')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })

    fireEvent.keyDown(overview, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Diff · 2' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Diff · 2' })).toHaveAttribute('aria-selected', 'true')

    const visibleFileTabs = screen.getByRole('tablist', { name: 'Changed files' })
    const visibleAnswer = within(visibleFileTabs).getByRole('tab', { name: /answer\.ts/ })
    fireEvent.keyDown(visibleAnswer, { key: 'End' })
    expect(within(visibleFileTabs).getByRole('tab', { name: /diagram\.png/ })).toHaveFocus()
    expect(within(visibleFileTabs).getByRole('tab', { name: /diagram\.png/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    const visibleFileView = screen.getByRole('tablist', { name: 'File view' })
    const preview = within(visibleFileView).getByRole('tab', { name: 'Preview' })
    fireEvent.keyDown(preview, { key: 'ArrowRight' })
    expect(within(visibleFileView).getByRole('tab', { name: 'Diff' })).toHaveFocus()
    expect(within(visibleFileView).getByRole('tab', { name: 'Diff' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    const activeFileBeforeMonacoKey = within(visibleFileTabs).getByRole('tab', {
      name: /diagram\.png/
    })
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Monaco input' }), {
      key: 'ArrowLeft'
    })
    expect(activeFileBeforeMonacoKey).toHaveAttribute('aria-selected', 'true')

    scrollIntoView.mockClear()
    fireEvent.click(within(rail).getAllByRole('tab', { name: /Changes/ })[0])
    expect(scrollIntoView).not.toHaveBeenCalled()
    const currentRail = screen.getByRole('tablist', { name: 'Artifacts' })
    await waitFor(() =>
      expect(within(currentRail).getAllByRole('tab', { name: /Changes/ })[0]).toHaveAttribute(
        'tabindex',
        '0'
      )
    )

    fireEvent.keyDown(within(currentRail).getAllByRole('tab', { name: /Changes/ })[0], {
      key: 'ArrowLeft'
    })
    await waitFor(() =>
      expect(
        within(screen.getByRole('tablist', { name: 'Artifacts' })).getAllByRole('tab', {
          name: /Changes/
        })[1]
      ).toHaveFocus()
    )
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('keeps rail focus when keyboard navigation switches between artifact and diff content', async () => {
    seedDiffReview()
    useAppStore.setState({ loadArtifactComments: vi.fn(() => Promise.resolve()) } as never)
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')
    const artifact = {
      type: 'artifact',
      id: 'event-plan',
      artifactId: 'plan-1',
      artifactType: 'plan',
      version: 1,
      title: 'Implementation plan',
      status: 'pending-review',
      body: '# Plan'
    } satisfies Extract<Event, { type: 'artifact' }>

    act(() => {
      useAppStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          conv_123: mergeConvoEvent(state.conversations.conv_123, artifact)
        }
      }))
    })

    const rail = screen.getByRole('tablist', { name: 'Artifacts' })
    const changes = within(rail).getByRole('tab', { name: /Changes/ })
    fireEvent.keyDown(changes, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Implementation Plan v1/ })).toHaveFocus()
    )

    fireEvent.keyDown(screen.getByRole('tab', { name: /Implementation Plan v1/ }), {
      key: 'ArrowRight'
    })
    await waitFor(() => expect(screen.getByRole('tab', { name: /Changes/ })).toHaveFocus())
  })

  it('labels a single diff as a direct region when no artifact rail is rendered', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)

    await screen.findByTestId('monaco-diff-stub')

    expect(screen.queryByRole('tablist', { name: 'Artifacts' })).toBeNull()
    const content = screen.getByRole('region', { name: 'Diff review content' })
    expect(content).not.toHaveAttribute('id', 'artifacts-rail-content')
    expect(content).not.toHaveAttribute('aria-labelledby')
    expect(document.getElementById('artifacts-rail-tab-diff:diff_123')).toBeNull()
    for (const tab of screen.getAllByRole('tab')) {
      expect(document.getElementById(tab.getAttribute('aria-controls')!)).not.toBeNull()
    }
    for (const panel of document.querySelectorAll<HTMLElement>('[aria-labelledby]')) {
      expect(document.getElementById(panel.getAttribute('aria-labelledby')!)).not.toBeNull()
    }
  })

  it('uses shared Monaco languages while retaining rendered and source body defaults', async () => {
    getDiff.mockResolvedValueOnce(classificationDiff)
    seedDiffReview(classificationDiff)
    render(<ArtifactsPane />)

    expect(await screen.findByTestId('monaco-diff-stub')).toHaveAttribute('data-language', 'ruby')

    fireEvent.click(screen.getByRole('tab', { name: /main\.go/ }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-language', 'go')

    fireEvent.click(screen.getByRole('tab', { name: /lib\.rs/ }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-language', 'rust')

    fireEvent.click(screen.getByRole('tab', { name: /icon\.svg/ }))
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_svg')

    fireEvent.click(screen.getByRole('tab', { name: /index\.html/ }))
    expect(await screen.findByTestId('monaco-code-stub')).toHaveAttribute('data-language', 'html')

    fireEvent.click(screen.getByRole('tab', { name: /notes\.md/ }))
    expect(await screen.findByTestId('monaco-code-stub')).toHaveAttribute(
      'data-language',
      'markdown'
    )
  })

  it('remembers Diff, Code, and Preview choices independently for each file', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))
    expect(await screen.findByTestId('monaco-code-stub')).toHaveAttribute(
      'data-language',
      'typescript'
    )

    fireEvent.click(screen.getByRole('tab', { name: /diagram\.png/ }))
    expect(screen.getByTestId('file-preview-stub')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }))
    expect(await screen.findByTestId('monaco-code-stub')).toHaveAttribute(
      'data-language',
      'plaintext'
    )

    fireEvent.click(screen.getByRole('tab', { name: /answer\.ts/ }))
    expect(screen.getByTestId('monaco-code-stub')).toHaveAttribute('data-language', 'typescript')

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_typescript')
    fireEvent.click(screen.getByRole('tab', { name: /diagram\.png/ }))
    expect(screen.getByTestId('monaco-code-stub')).toHaveAttribute('data-language', 'plaintext')
    fireEvent.click(screen.getByRole('tab', { name: /answer\.ts/ }))
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_typescript')
  })

  it('copies the active after-text and waits to toast until the write resolves', async () => {
    const pending = deferred<void>()
    writeClipboard.mockReturnValueOnce(pending.promise)
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Copy file' }))

    expect(writeClipboard).toHaveBeenCalledWith('export const answer = 42\n')
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve(undefined)
    })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Copied answer.ts'))
  })

  it('reports a rejected clipboard write without emitting an unhandled success', async () => {
    writeClipboard.mockRejectedValueOnce(new Error('clipboard unavailable'))
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Copy file' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not copy file'))
    expect(showToast).not.toHaveBeenCalledWith('Copied answer.ts')
  })

  it('opens the active file through the diff API', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }))

    await waitFor(() => expect(openDiff).toHaveBeenCalledWith('file_typescript'))
  })

  it('reverts only the requested file and reports the existing confirmation', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Revert change' }))

    await waitFor(() => expect(revertDiff).toHaveBeenCalledWith('file_typescript'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Change reverted'))
    expect(screen.getByRole('tab', { name: /answer\.ts/ })).toHaveTextContent('Reverted')

    fireEvent.click(screen.getByRole('tab', { name: /diagram\.png/ }))
    expect(screen.getByRole('tab', { name: /diagram\.png/ })).not.toHaveTextContent('Reverted')
  })

  it('reports a rejected revert and leaves the file applied', async () => {
    revertDiff.mockRejectedValueOnce(new Error('revert unavailable'))
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Revert change' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not revert change'))
    expect(showToast).not.toHaveBeenCalledWith('Change reverted')
    expect(screen.getByRole('tab', { name: /answer\.ts/ })).not.toHaveTextContent('Reverted')
  })

  it('keeps comments scoped to their file and reflects their marked lines in each editor', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-commented-lines', '7')

    fireEvent.click(screen.getByRole('tab', { name: /diagram\.png/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))
    await screen.findByTestId('monaco-code-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 12' }))
    expect(screen.getByTestId('monaco-code-stub')).toHaveAttribute('data-commented-lines', '12')
    expect(screen.getByText('answer.ts:7')).toBeInTheDocument()
    expect(screen.getByText('diagram.png:12')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /answer\.ts/ }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-commented-lines', '7')

    fireEvent.click(
      within(screen.getByText('answer.ts:7').closest('.comment-row')!).getByRole('button')
    )
    expect(screen.queryByText('answer.ts:7')).toBeNull()
    expect(screen.getByText('diagram.png:12')).toBeInTheDocument()
  })

  it('preserves a comment when rail navigation unmounts its diff and later returns', async () => {
    getDiff.mockImplementation((id: string) =>
      Promise.resolve(id === secondDiff.diffId ? secondDiff : diff)
    )
    seedDiffReview(diff, null, [diff, secondDiff])
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))
    expect(screen.getByText('answer.ts:7')).toBeInTheDocument()

    fireEvent.click(
      screen
        .getAllByRole('tab', { name: /Changes/ })
        .find((button) => button.textContent?.includes('1 file'))!
    )
    expect(await screen.findByText('export const second = 2')).toBeInTheDocument()

    fireEvent.click(
      screen
        .getAllByRole('tab', { name: /Changes/ })
        .find((button) => button.textContent?.includes('2 files'))!
    )
    expect(await screen.findByText('answer.ts:7')).toBeInTheDocument()
    expect(screen.getByText('Check the answer')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(useAppStore.getState().diffReviewComments['diff_123']).toHaveLength(1)
    await act(async () => {
      useAppStore.getState().openReview('diff_123')
    })
    expect(await screen.findByText('answer.ts:7')).toBeInTheDocument()
  })

  it('keeps comments and the pane open when dispatch returns false', async () => {
    sendReview.mockResolvedValueOnce(false)
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))

    fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment' }))

    await waitFor(() => expect(sendReview).toHaveBeenCalledOnce())
    expect(sendReview).toHaveBeenCalledWith(
      'conv_123',
      'Please address these review comments:\n' +
        '- /workspace/src/answer.ts line 7: Check the answer'
    )
    expect(screen.getByText('answer.ts:7')).toBeInTheDocument()
    expect(useAppStore.getState().auxSelection).toEqual({
      kind: 'diff',
      diffId: 'diff_123'
    })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('waits for accepted dispatch before clearing, toasting, and closing', async () => {
    const pending = deferred<boolean>()
    sendReview.mockReturnValueOnce(pending.promise)
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))

    fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment' }))

    expect(screen.getByText('answer.ts:7')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send 1 comment' })).toBeDisabled()
    expect(showToast).not.toHaveBeenCalled()
    expect(useAppStore.getState().auxSelection).not.toBeNull()

    await act(async () => {
      pending.resolve(true)
    })

    expect(useAppStore.getState().diffReviewComments['diff_123']).toBeUndefined()
    expect(useAppStore.getState().auxSelection).toBeNull()
    expect(showToast).toHaveBeenCalledWith('Sent 1 comment')
  })

  it('blocks duplicate review sends while dispatch is pending', async () => {
    const pending = deferred<boolean>()
    sendReview.mockReturnValueOnce(pending.promise)
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))

    const sendButton = screen.getByRole('button', { name: 'Send 1 comment' })
    fireEvent.click(sendButton)
    fireEvent.click(sendButton)

    expect(sendReview).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve(false)
    })
  })

  it('keeps the send guard across remount and does not close a newer selection', async () => {
    const pending = deferred<boolean>()
    sendReview.mockReturnValueOnce(pending.promise)
    getDiff.mockImplementation((id: string) =>
      Promise.resolve(id === secondDiff.diffId ? secondDiff : diff)
    )
    seedDiffReview(diff, null, [diff, secondDiff])
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment' }))

    const railButton = (fileCount: string): HTMLElement =>
      screen
        .getAllByRole('tab', { name: /Changes/ })
        .find((button) => button.textContent?.includes(fileCount))!

    fireEvent.click(railButton('1 file'))
    await screen.findByText('export const second = 2')
    fireEvent.click(railButton('2 files'))
    await screen.findByText('export const answer = 42')

    const remountedSend = screen.getByRole('button', { name: 'Send 1 comment' })
    expect(remountedSend).toBeDisabled()
    fireEvent.click(remountedSend)
    expect(sendReview).toHaveBeenCalledOnce()

    fireEvent.click(railButton('1 file'))
    await screen.findByText('export const second = 2')
    await act(async () => {
      pending.resolve(true)
    })

    expect(useAppStore.getState().auxSelection).not.toBeNull()
    expect(screen.getByText('export const second = 2')).toBeInTheDocument()
  })

  it('retains comments added during an accepted pending send', async () => {
    const pending = deferred<boolean>()
    sendReview.mockReturnValueOnce(pending.promise)
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')
    const addButton = screen.getByRole('button', { name: 'Add comment at line 7' })
    fireEvent.click(addButton)

    fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment' }))
    fireEvent.click(addButton)
    expect(screen.getAllByText('answer.ts:7')).toHaveLength(2)

    await act(async () => {
      pending.resolve(true)
    })

    expect(useAppStore.getState().diffReviewComments['diff_123']).toHaveLength(1)
    expect(useAppStore.getState().diffReviewComments['diff_123'][0]).toMatchObject({
      path: '/workspace/src/answer.ts',
      line: 7,
      text: 'Check the answer'
    })
  })
})

describe('ArtifactsPane file review loading', () => {
  it('hides a completed old file while a new conversation request is loading', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    seedFileReview('/workspace/src/answer.ts')

    render(<ArtifactsPane />)
    await act(async () => {
      first.resolve('const answer = 41\n')
    })
    expect(await screen.findByTestId('monaco-code-stub')).toHaveTextContent('const answer = 41')

    await act(async () => {
      useAppStore.setState({
        view: { kind: 'conversation', id: 'conv_456' },
        conversations: { conv_456: conversation('conv_456', []) }
      } as never)
    })
    expect(screen.getByText('Loading file…')).toBeInTheDocument()
    expect(screen.queryByText('const answer = 41')).toBeNull()

    await act(async () => {
      second.resolve('const answer = 42\n')
    })
    expect(await screen.findByTestId('monaco-code-stub')).toHaveTextContent('const answer = 42')
  })

  it('ignores an older file response after a newer conversation request resolves', async () => {
    const oldRequest = deferred<string>()
    const newRequest = deferred<string>()
    readFile.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    seedFileReview('/workspace/src/answer.ts')

    render(<ArtifactsPane />)
    await act(async () => {
      useAppStore.setState({
        view: { kind: 'conversation', id: 'conv_456' },
        conversations: { conv_456: conversation('conv_456', []) }
      } as never)
    })
    await act(async () => {
      newRequest.resolve('const answer = 42\n')
    })
    expect(await screen.findByTestId('monaco-code-stub')).toHaveTextContent('const answer = 42')

    await act(async () => {
      oldRequest.resolve('const answer = 41\n')
    })
    expect(screen.getByTestId('monaco-code-stub')).toHaveTextContent('const answer = 42')
  })

  it('hides rendered old-path content while a new-path request is loading', async () => {
    const oldRequest = deferred<string>()
    const newRequest = deferred<string>()
    readFile.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    seedFileReview('/workspace/src/old.ts')

    render(<ArtifactsPane />)
    await act(async () => {
      oldRequest.resolve('const oldPath = true\n')
    })
    expect(await screen.findByTestId('monaco-code-stub')).toHaveTextContent('const oldPath = true')

    await act(async () => {
      useAppStore.setState({
        auxSelection: { kind: 'file', path: '/workspace/src/new.ts' },
        auxPaneOpenTick: 1
      } as never)
    })
    expect(screen.getByText('Loading file…')).toBeInTheDocument()
    expect(screen.queryByText('const oldPath = true')).toBeNull()

    await act(async () => {
      newRequest.resolve('const newPath = true\n')
    })
    expect(await screen.findByTestId('monaco-code-stub')).toHaveTextContent('const newPath = true')
  })

  it('ignores a pending old-path response after the selected path changes', async () => {
    const oldRequest = deferred<string>()
    const newRequest = deferred<string>()
    readFile.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    seedFileReview('/workspace/src/old.ts')

    render(<ArtifactsPane />)
    await act(async () => {
      useAppStore.setState({
        auxSelection: { kind: 'file', path: '/workspace/src/new.ts' },
        auxPaneOpenTick: 1
      } as never)
    })
    expect(screen.getByText('Loading file…')).toBeInTheDocument()
    expect(screen.queryByText('const oldPath = true')).toBeNull()

    await act(async () => {
      newRequest.resolve('const newPath = true\n')
    })
    expect(await screen.findByTestId('monaco-code-stub')).toHaveTextContent('const newPath = true')

    await act(async () => {
      oldRequest.resolve('const oldPath = true\n')
    })
    expect(screen.getByTestId('monaco-code-stub')).toHaveTextContent('const newPath = true')
    expect(screen.queryByText('const oldPath = true')).toBeNull()
  })

  it('shows the existing error state when file loading rejects', async () => {
    readFile.mockRejectedValueOnce(new Error('read failed'))
    seedFileReview('/workspace/src/answer.ts')

    render(<ArtifactsPane />)

    expect(await screen.findByText("Couldn't open file")).toBeInTheDocument()
    expect(screen.queryByText('Loading file…')).toBeNull()
  })
})
