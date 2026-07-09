// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { BearcodeApi } from '@shared/types'
import { useAppStore } from '../../state/store'
import { ConflictResolver } from './ConflictResolver'

// The editable Monaco editor can't run in jsdom; stub it with a textarea that
// mirrors the same controlled value/onChange contract the resolver drives.
vi.mock('../MonacoEditable', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="conflict-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}))

const MARKER = [
  'line 1',
  '<<<<<<< HEAD',
  'our change',
  '=======',
  'their change',
  '>>>>>>> bearcode/x',
  'line 2'
].join('\n')

let merge: ReturnType<typeof vi.fn>
let readConflict: ReturnType<typeof vi.fn>
let resolveFile: ReturnType<typeof vi.fn>
let completeMerge: ReturnType<typeof vi.fn>
let abort: ReturnType<typeof vi.fn>

function seedConflict(files: string[] = ['a.txt'], index = 0): void {
  useAppStore.setState({
    conflict: { convId: 'c1', repoPath: '/proj/repo-a', files, index }
  } as never)
}

beforeEach(() => {
  merge = vi.fn(async () => ({ status: 'clean' as const, conflictedFiles: [] }))
  readConflict = vi.fn(async () => ({ merged: MARKER }))
  resolveFile = vi.fn(async () => {})
  completeMerge = vi.fn(async () => {})
  abort = vi.fn(async () => {})
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    worktree: { merge, readConflict, resolveFile, completeMerge, abort, discard: vi.fn() }
  } as unknown as BearcodeApi
  useAppStore.setState({ conflict: null } as never)
})
afterEach(cleanup)

const editor = (): HTMLTextAreaElement =>
  screen.getByTestId('conflict-editor') as HTMLTextAreaElement

describe('ConflictResolver', () => {
  it('renders nothing when there is no active conflict', () => {
    const { container } = render(<ConflictResolver />)
    expect(container.firstChild).toBeNull()
  })

  it('loads the current conflicted file into the editor', async () => {
    seedConflict()
    render(<ConflictResolver />)
    await waitFor(() => expect(readConflict).toHaveBeenCalledWith('c1', '/proj/repo-a', 'a.txt'))
    await waitFor(() => expect(editor().value).toBe(MARKER))
  })

  it('Accept ours / Accept theirs transform the editor buffer via applyChoice', async () => {
    seedConflict()
    render(<ConflictResolver />)
    await waitFor(() => expect(editor().value).toBe(MARKER))

    fireEvent.click(screen.getByRole('button', { name: /accept ours/i }))
    expect(editor().value).toBe('line 1\nour change\nline 2')

    fireEvent.click(screen.getByRole('button', { name: /accept theirs/i }))
    expect(editor().value).toBe('line 1\ntheir change\nline 2')
  })

  it('Mark resolved writes the current buffer via resolveFile', async () => {
    seedConflict()
    render(<ConflictResolver />)
    await waitFor(() => expect(editor().value).toBe(MARKER))
    fireEvent.click(screen.getByRole('button', { name: /accept ours/i }))
    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }))
    await waitFor(() =>
      expect(resolveFile).toHaveBeenCalledWith(
        'c1',
        '/proj/repo-a',
        'a.txt',
        'line 1\nour change\nline 2'
      )
    )
  })

  it('after resolving every file, Complete merge commits and clears the conflict', async () => {
    seedConflict(['a.txt'])
    render(<ConflictResolver />)
    await waitFor(() => expect(editor().value).toBe(MARKER))
    fireEvent.click(screen.getByRole('button', { name: /accept ours/i }))
    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }))

    // With the single file resolved, the Complete-merge affordance appears.
    const complete = await screen.findByRole('button', { name: /complete merge/i })
    fireEvent.click(complete)
    await waitFor(() => expect(completeMerge).toHaveBeenCalledWith('c1', '/proj/repo-a'))
    await waitFor(() => expect(useAppStore.getState().conflict).toBeNull())
  })

  it('walks multiple files before offering Complete merge', async () => {
    seedConflict(['a.txt', 'b.txt'])
    render(<ConflictResolver />)
    await waitFor(() => expect(readConflict).toHaveBeenCalledWith('c1', '/proj/repo-a', 'a.txt'))
    fireEvent.click(screen.getByRole('button', { name: /accept ours/i }))
    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }))
    // Second file loads; no Complete merge yet.
    await waitFor(() => expect(readConflict).toHaveBeenCalledWith('c1', '/proj/repo-a', 'b.txt'))
    expect(screen.queryByRole('button', { name: /complete merge/i })).toBeNull()
  })

  it('Abort aborts the merge and clears the conflict', async () => {
    seedConflict()
    render(<ConflictResolver />)
    await waitFor(() => expect(editor().value).toBe(MARKER))
    // Exact name to disambiguate from the header's "Abort merge" close button.
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }))
    await waitFor(() => expect(abort).toHaveBeenCalledWith('c1', '/proj/repo-a'))
    await waitFor(() => expect(useAppStore.getState().conflict).toBeNull())
  })
})
