// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilePreview } from './FilePreview'

vi.mock('../MonacoCode', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="monaco-stub">{value}</pre>
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FilePreview', () => {
  it('loads and renders the requested file preview', async () => {
    const previewFile = vi.fn(() => Promise.resolve({ kind: 'text', text: 'HELLO' }))
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByText } = render(<FilePreview fileId="f1" />)
    expect(await findByText('HELLO')).toBeTruthy()
    expect(previewFile).toHaveBeenCalledWith('f1')
  })

  it("does not replace the current file's loading state with a stale preview", async () => {
    let resolveFirst: ((payload: { kind: 'text'; text: string }) => void) | undefined
    let resolveSecond: ((payload: { kind: 'text'; text: string }) => void) | undefined
    const previewFile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })

    const { rerender } = render(<FilePreview fileId="first" />)
    rerender(<FilePreview fileId="second" />)

    await act(async () => {
      resolveFirst?.({ kind: 'text', text: 'STALE' })
    })

    expect(screen.getByText('Loading preview…')).toBeInTheDocument()
    expect(screen.queryByText('STALE')).not.toBeInTheDocument()

    await act(async () => {
      resolveSecond?.({ kind: 'text', text: 'CURRENT' })
    })
    expect(screen.getByText('CURRENT')).toBeInTheDocument()
  })
})
