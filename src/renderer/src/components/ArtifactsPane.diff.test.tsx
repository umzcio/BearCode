// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, Event, FileDiff } from '@shared/types'
import { useAppStore, type Convo } from '../state/store'
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

const emptyDiff: FileDiff = { diffId: 'diff_empty', files: [] }

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
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))

    await act(async () => {
      pending.resolve(diff)
    })

    expect(screen.getByRole('button', { name: 'Diff · 2' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: /diagram\.png/ })).toHaveClass('active')
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_png')
  })

  it('consumes an unknown focus path and falls back to the first file', async () => {
    const pending = deferred<FileDiff>()
    getDiff.mockReturnValueOnce(pending.promise)
    seedDiffReview(diff, '/workspace/src/missing.ts')

    render(<ArtifactsPane />)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))

    await act(async () => {
      pending.resolve(diff)
    })

    expect(screen.getByRole('button', { name: 'Diff · 2' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: /answer\.ts/ })).toHaveClass('active')
    expect(screen.getByTestId('monaco-diff-stub')).toBeInTheDocument()
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
        .getAllByRole('button', { name: /Changes/ })
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
    expect(screen.getByRole('button', { name: /answer\.ts/ })).toHaveClass('active')
  })

  it('shows the originating prompt and every changed file in Overview', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))

    expect(screen.getByText('Please add the answer and diagram.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /answer\.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /diagram\.png/ })).toBeInTheDocument()
  })

  it('returns from an Overview row to Diff mode on that exact file', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))

    expect(screen.getByRole('button', { name: /diagram\.png/ })).toHaveClass('active')
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_png')
  })

  it('switches file tabs and defaults code to Diff while PNG defaults to Preview', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    expect(await screen.findByTestId('monaco-diff-stub')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_png')

    fireEvent.click(screen.getByRole('button', { name: /answer\.ts/ }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-language', 'typescript')
  })

  it('remembers Diff, Code, and Preview choices independently for each file', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(await screen.findByTestId('monaco-code-stub')).toHaveAttribute(
      'data-language',
      'typescript'
    )

    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))
    expect(screen.getByTestId('file-preview-stub')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(await screen.findByTestId('monaco-code-stub')).toHaveAttribute(
      'data-language',
      'plaintext'
    )

    fireEvent.click(screen.getByRole('button', { name: /answer\.ts/ }))
    expect(screen.getByTestId('monaco-code-stub')).toHaveAttribute('data-language', 'typescript')

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByTestId('file-preview-stub')).toHaveTextContent('file_typescript')
    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))
    expect(screen.getByTestId('monaco-code-stub')).toHaveAttribute('data-language', 'plaintext')
    fireEvent.click(screen.getByRole('button', { name: /answer\.ts/ }))
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
    expect(screen.getByRole('button', { name: /answer\.ts/ })).toHaveTextContent('Reverted')

    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))
    expect(screen.getByRole('button', { name: /diagram\.png/ })).not.toHaveTextContent('Reverted')
  })

  it('keeps comments scoped to their file and reflects their marked lines in each editor', async () => {
    seedDiffReview()
    render(<ArtifactsPane />)
    await screen.findByTestId('monaco-diff-stub')

    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 7' }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-commented-lines', '7')

    fireEvent.click(screen.getByRole('button', { name: /diagram\.png/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    await screen.findByTestId('monaco-code-stub')
    fireEvent.click(screen.getByRole('button', { name: 'Add comment at line 12' }))
    expect(screen.getByTestId('monaco-code-stub')).toHaveAttribute('data-commented-lines', '12')
    expect(screen.getByText('answer.ts:7')).toBeInTheDocument()
    expect(screen.getByText('diagram.png:12')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /answer\.ts/ }))
    expect(screen.getByTestId('monaco-diff-stub')).toHaveAttribute('data-commented-lines', '7')

    fireEvent.click(
      within(screen.getByText('answer.ts:7').closest('.comment-row')!).getByRole('button')
    )
    expect(screen.queryByText('answer.ts:7')).toBeNull()
    expect(screen.getByText('diagram.png:12')).toBeInTheDocument()
  })
})
