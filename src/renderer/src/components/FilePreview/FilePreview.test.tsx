// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { FilePreview } from './FilePreview'

vi.mock('../MonacoCode', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="monaco-stub">{value}</pre>
}))

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

  it('renders markdown payloads via the Markdown component', async () => {
    const previewFile = vi.fn(() => Promise.resolve({ kind: 'markdown', text: '# Hi' }))
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByText } = render(<FilePreview fileId="f4" />)
    const heading = await findByText('Hi')
    expect(heading.tagName).toBe('H5')
    vi.unstubAllGlobals()
  })

  it('renders table payloads as an HTML table', async () => {
    const previewFile = vi.fn(() =>
      Promise.resolve({ kind: 'table', rows: [['a', 'b']] })
    )
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByText } = render(<FilePreview fileId="f5" />)
    expect(await findByText('a')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('renders pdf payloads as an iframe with the data URL', async () => {
    const previewFile = vi.fn(() =>
      Promise.resolve({ kind: 'pdf', dataUrl: 'data:application/pdf;base64,x' })
    )
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByTitle } = render(<FilePreview fileId="f6" />)
    const iframe = (await findByTitle('preview')) as HTMLIFrameElement
    expect(iframe.src).toBe('data:application/pdf;base64,x')
    vi.unstubAllGlobals()
  })

  it('renders code payloads via lazy MonacoCode', async () => {
    const previewFile = vi.fn(() =>
      Promise.resolve({ kind: 'code', text: 'const x = 1', language: 'typescript' })
    )
    vi.stubGlobal('window', { bearcode: { diffs: { previewFile } } })
    const { findByTestId } = render(<FilePreview fileId="f7" />)
    const stub = await findByTestId('monaco-stub')
    expect(stub.textContent).toBe('const x = 1')
    vi.unstubAllGlobals()
  })
})
