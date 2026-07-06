// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { FilePreview } from './FilePreview'

afterEach(cleanup)

describe('FilePreview', () => {
  it('renders text payloads', async () => {
    const previewFile = vi.fn(() => Promise.resolve({ kind: 'text', text: 'HELLO' }))
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByText } = render(<FilePreview fileId="f1" />)
    expect(await findByText('HELLO')).toBeTruthy()
    expect(previewFile).toHaveBeenCalledWith('f1')
    vi.unstubAllGlobals()
  })

  it('renders image payloads as an img', async () => {
    const previewFile = vi.fn(() =>
      Promise.resolve({ kind: 'image', dataUrl: 'data:image/png;base64,x' })
    )
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByAltText } = render(<FilePreview fileId="f2" />)
    const img = (await findByAltText('preview')) as HTMLImageElement
    expect(img.src).toBe('data:image/png;base64,x')
    vi.unstubAllGlobals()
  })

  it('renders unsupported note', async () => {
    const previewFile = vi.fn(() => Promise.resolve({ kind: 'unsupported', note: 'nope' }))
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByText } = render(<FilePreview fileId="f3" />)
    expect(await findByText('nope')).toBeTruthy()
    vi.unstubAllGlobals()
  })
})
