// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Markdown } from './markdown'

afterEach(cleanup)

describe('Markdown citation markers', () => {
  const citations = [{ url: 'https://one.example', title: 'One' }, { url: 'https://two.example' }]

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

describe('Markdown streamed-block materialization', () => {
  it('marks only the last block ms-stream-in while streaming', () => {
    const { container } = render(
      <Markdown text={'First para\n\nSecond para'} trailing={<span className="cursor" />} />
    )
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].className).not.toContain('ms-stream-in')
    expect(paragraphs[1].className).toContain('ms-stream-in')
  })

  it('renders settled history (no trailing) with no stream-in class anywhere', () => {
    const { container } = render(
      <Markdown text={'First para\n\n- item\n\n```\ncode\n```\n\nLast para'} />
    )
    expect(container.querySelector('.ms-stream-in')).toBeNull()
  })

  it('moves the class to the newly appended block and clears it when streaming settles', () => {
    const { container, rerender } = render(
      <Markdown text="Alpha" trailing={<span className="cursor" />} />
    )
    expect(container.querySelector('p')!.className).toContain('ms-stream-in')
    rerender(<Markdown text={'Alpha\n\nBeta'} trailing={<span className="cursor" />} />)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs[0].className).not.toContain('ms-stream-in')
    expect(paragraphs[1].className).toContain('ms-stream-in')
    rerender(<Markdown text={'Alpha\n\nBeta'} />)
    expect(container.querySelector('.ms-stream-in')).toBeNull()
  })

  it('marks a streaming code block via its code-card root', () => {
    const { container } = render(
      <Markdown text={'Intro\n\n```ts\nconst a = 1\n```'} trailing={<span className="cursor" />} />
    )
    const card = container.querySelector('.code-card')!
    expect(card.className).toContain('ms-stream-in')
    expect(container.querySelector('p')!.className).not.toContain('ms-stream-in')
  })
})

describe('Markdown citation chip stagger', () => {
  it('assigns document-order --ms-i to cite chips, capped at 6', () => {
    const citations = Array.from({ length: 9 }, (_, i) => ({ url: `https://e.example/${i + 1}` }))
    const text = 'a[1] b[2] c[3] d[4] e[5] f[6] g[7] h[8] i[9]'
    render(<Markdown text={text} citations={citations} />)
    const refs = screen.getAllByRole('link')
    expect(refs).toHaveLength(9)
    expect(refs[0].style.getPropertyValue('--ms-i')).toBe('0')
    expect(refs[1].style.getPropertyValue('--ms-i')).toBe('1')
    expect(refs[5].style.getPropertyValue('--ms-i')).toBe('5')
    // 7th chip onward stays at the 6-step cap
    expect(refs[6].style.getPropertyValue('--ms-i')).toBe('6')
    expect(refs[8].style.getPropertyValue('--ms-i')).toBe('6')
  })
})

describe('Markdown inline links', () => {
  it('renders [text](url) as an external link and [[n]](url) as a cite chip', () => {
    render(
      <Markdown text="See [zachrossmiller.com](https://www.zachrossmiller.com/) and a fact.[[1]](https://umt.edu/it)" />
    )
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0].className).toBe('md-link')
    expect(links[0].getAttribute('href')).toBe('https://www.zachrossmiller.com/')
    expect(links[0].textContent).toBe('zachrossmiller.com')
    expect(links[1].className).toBe('cite-ref')
    expect(links[1].textContent).toBe('1')
    expect(links[1].getAttribute('href')).toBe('https://umt.edu/it')
    // No raw markdown syntax survives
    expect(document.body.textContent).not.toContain('](')
  })
})
