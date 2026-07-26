// @vitest-environment jsdom
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

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
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

  it('renders HTML strings in an opaque sandbox that allows scripts', () => {
    render(<PreviewContent payload={{ kind: 'html', html: '<h1>Hello</h1>' }} />)

    const frame = screen.getByTitle('preview')
    expect(frame).toHaveAttribute('src', 'blob:preview')
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
