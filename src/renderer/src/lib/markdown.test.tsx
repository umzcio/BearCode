// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Markdown } from './markdown'

afterEach(cleanup)

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
