// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Markdown } from './markdown'

afterEach(cleanup)

describe('Markdown citation markers', () => {
  const citations = [
    { url: 'https://one.example', title: 'One' },
    { url: 'https://two.example' }
  ]

  it('linkifies in-range [n] markers against the citations list (1-based)', () => {
    render(<Markdown text="A fact.[2] Another **bold[1]** claim.[7]" citations={citations} />)
    const refs = screen.getAllByRole('link')
    // [2] and the [1] inside bold both linkify; [7] is out of range and stays text
    expect(refs).toHaveLength(2)
    expect(refs[0].getAttribute('href')).toBe('https://two.example')
    expect(refs[0].textContent).toBe('2')
    expect(refs[1].getAttribute('href')).toBe('https://one.example')
    expect(document.body.textContent).toContain('[7]')
  })

  it('leaves [n] untouched when no citations are supplied', () => {
    render(<Markdown text="Item one.[1]" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.body.textContent).toContain('[1]')
  })
})

describe('Markdown file chips', () => {
  it('renders a spaced absolute path in backticks as code.tok.file', () => {
    render(
      <Markdown
        text="See `/Users/zach/Desktop/New test/index.html` for details."
        onFileClick={vi.fn()}
      />
    )
    const chip = screen.getByText('/Users/zach/Desktop/New test/index.html')
    expect(chip.tagName).toBe('CODE')
    expect(chip.className).toContain('tok')
    expect(chip.className).toContain('file')
  })

  it('plain click calls onFileClick', () => {
    const onFileClick = vi.fn()
    const onFileOpen = vi.fn()
    render(<Markdown text="`src/app.ts`" onFileClick={onFileClick} onFileOpen={onFileOpen} />)
    fireEvent.click(screen.getByText('src/app.ts'))
    expect(onFileClick).toHaveBeenCalledWith('src/app.ts')
    expect(onFileOpen).not.toHaveBeenCalled()
  })

  it('Cmd-click calls onFileOpen, not onFileClick', () => {
    const onFileClick = vi.fn()
    const onFileOpen = vi.fn()
    render(<Markdown text="`src/app.ts`" onFileClick={onFileClick} onFileOpen={onFileOpen} />)
    fireEvent.click(screen.getByText('src/app.ts'), { metaKey: true })
    expect(onFileOpen).toHaveBeenCalledWith('src/app.ts')
    expect(onFileClick).not.toHaveBeenCalled()
  })

  it('a normal word chip stays plain .tok (no file class)', () => {
    render(<Markdown text="`someVar`" onFileClick={vi.fn()} />)
    const chip = screen.getByText('someVar')
    expect(chip.tagName).toBe('CODE')
    expect(chip.className).toBe('tok')
  })
})

describe('Markdown paragraph line breaks', () => {
  it('preserves single line breaks within a paragraph as <br>', () => {
    const { container } = render(<Markdown text={'Line one\nLine two\nLine three'} />)
    const p = container.querySelector('p')
    expect(p).not.toBeNull()
    expect(p!.querySelectorAll('br')).toHaveLength(2)
    expect(p!.textContent).toBe('Line oneLine twoLine three')
  })

  it('still starts a new paragraph on a blank line', () => {
    const { container } = render(<Markdown text={'First para\n\nSecond para'} />)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].textContent).toBe('First para')
    expect(paragraphs[1].textContent).toBe('Second para')
  })

  it('renders a lone "---" line as visible text on its own line, not swallowed mid-sentence', () => {
    const { container } = render(<Markdown text={'Before\n---\nAfter'} />)
    const p = container.querySelector('p')
    expect(p!.querySelectorAll('br')).toHaveLength(2)
    expect(p!.textContent).toBe('Before---After')
  })
})
