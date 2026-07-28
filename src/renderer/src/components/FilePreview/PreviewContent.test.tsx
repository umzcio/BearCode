// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PreviewContent } from './PreviewContent'

vi.mock('../MonacoCode', () => ({
  default: ({ value, language }: { value: string; language: string }): React.JSX.Element => (
    <pre data-testid="monaco-code" data-language={language}>
      {value}
    </pre>
  )
}))

let createdUrls: string[]
let revokedUrls: string[]
let lifecycle: Array<{ action: 'create' | 'revoke'; url: string }>

beforeEach(() => {
  createdUrls = []
  revokedUrls = []
  lifecycle = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:preview-${createdUrls.length + 1}`
    createdUrls.push(url)
    lifecycle.push({ action: 'create', url })
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revokedUrls.push(url)
    lifecycle.push({ action: 'revoke', url })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PreviewContent', () => {
  it('renders markdown through the sanitized Markdown component', () => {
    const { container } = render(
      <PreviewContent
        payload={{ kind: 'markdown', text: '# Safe\n<script>window.pwned = true</script>' }}
      />
    )

    expect(screen.getByRole('heading', { name: 'Safe' })).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('<script>window.pwned = true</script>')).toBeInTheDocument()
  })

  it('lazy-loads Monaco with the payload language', async () => {
    render(
      <PreviewContent
        payload={{ kind: 'code', text: 'const answer = 42', language: 'typescript' }}
      />
    )

    const code = await screen.findByTestId('monaco-code')
    expect(code).toHaveTextContent('const answer = 42')
    expect(code).toHaveAttribute('data-language', 'typescript')
  })

  it('omits the iframe source while new HTML awaits its committed resource', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)

    flushSync(() => {
      root.render(<PreviewContent payload={{ kind: 'html', html: '<h1>First</h1>' }} />)
    })
    await act(async () => {})
    expect(host.querySelector('iframe')).toHaveAttribute('src', 'blob:preview-1')

    flushSync(() => {
      root.render(<PreviewContent payload={{ kind: 'html', html: '<h1>Second</h1>' }} />)
    })
    expect(host.querySelector('iframe')).not.toHaveAttribute('src')

    flushSync(() => root.unmount())
  })

  it('pairs every committed HTML blob URL with one revocation in StrictMode', () => {
    const { unmount } = render(
      <StrictMode>
        <PreviewContent payload={{ kind: 'html', html: '<h1>Hello</h1>' }} />
      </StrictMode>
    )

    unmount()

    expect(createdUrls.length).toBeGreaterThan(0)
    expect(revokedUrls).toEqual(expect.arrayContaining(createdUrls))
    for (const url of createdUrls) {
      expect(revokedUrls.filter((revoked) => revoked === url)).toHaveLength(1)
    }

    const created = new Set<string>()
    for (const { action, url } of lifecycle) {
      if (action === 'create') created.add(url)
      else expect(created).toContain(url)
    }
  })

  it('replaces an HTML preview URL after its HTML changes in StrictMode', () => {
    const { rerender } = render(
      <StrictMode>
        <PreviewContent payload={{ kind: 'html', html: '<h1>First</h1>' }} />
      </StrictMode>
    )

    const priorUrl = screen.getByTitle('preview').getAttribute('src')

    rerender(
      <StrictMode>
        <PreviewContent payload={{ kind: 'html', html: '<h1>Second</h1>' }} />
      </StrictMode>
    )

    const currentUrl = screen.getByTitle('preview').getAttribute('src')
    expect(currentUrl).not.toBe(priorUrl)
    expect(createdUrls).toContain(currentUrl)
    expect(revokedUrls).toContain(priorUrl)
  })

  it('does not allocate an HTML blob URL for non-HTML payloads in StrictMode', () => {
    render(
      <StrictMode>
        <PreviewContent payload={{ kind: 'text', text: 'Plain text contents' }} />
      </StrictMode>
    )

    expect(createdUrls).toHaveLength(0)
  })

  it('renders HTML strings in an opaque sandbox that allows scripts', () => {
    render(
      <StrictMode>
        <PreviewContent payload={{ kind: 'html', html: '<h1>Hello</h1>' }} />
      </StrictMode>
    )

    const frame = screen.getByTitle('preview')
    expect(frame).toHaveAttribute('src', expect.stringMatching(/^blob:preview-/))
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('renders HTML URLs in an opaque sandbox that allows scripts', () => {
    render(
      <PreviewContent payload={{ kind: 'html-url', url: 'bearcode-preview://file/index.html' }} />
    )

    const frame = screen.getByTitle('preview')
    expect(frame).toHaveAttribute('src', 'bearcode-preview://file/index.html')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('renders image payloads from the payload data URL', () => {
    render(<PreviewContent payload={{ kind: 'image', dataUrl: 'data:image/png;base64,IMAGE' }} />)

    expect(screen.getByRole('img', { name: 'preview' })).toHaveAttribute(
      'src',
      'data:image/png;base64,IMAGE'
    )
  })

  it('renders PDF payloads from the payload data URL', () => {
    render(
      <PreviewContent payload={{ kind: 'pdf', dataUrl: 'data:application/pdf;base64,DOCUMENT' }} />
    )

    expect(screen.getByTitle('preview')).toHaveAttribute(
      'src',
      'data:application/pdf;base64,DOCUMENT'
    )
  })

  it('renders header and body table rows', () => {
    render(
      <PreviewContent
        payload={{
          kind: 'table',
          rows: [
            ['Name', 'Score'],
            ['Ada', '10'],
            ['Grace', '9']
          ]
        }}
      />
    )

    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '9' })).toBeInTheDocument()
  })

  it('renders unsupported preview messages', () => {
    render(<PreviewContent payload={{ kind: 'unsupported', note: 'No preview available' }} />)

    expect(screen.getByText('No preview available')).toBeInTheDocument()
  })

  it('renders text preview messages', () => {
    render(<PreviewContent payload={{ kind: 'text', text: 'Plain text contents' }} />)

    expect(screen.getByText('Plain text contents')).toBeInTheDocument()
  })
})
