// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Markdown } from './markdown'

describe('markdown file chip keyboard', () => {
  it('activates file click on Enter and open on Ctrl+Enter', () => {
    const onFileClick = vi.fn()
    const onFileOpen = vi.fn()
    render(
      <Markdown text="see `src/main/ipc.ts`" onFileClick={onFileClick} onFileOpen={onFileOpen} />
    )
    const chip = screen.getByRole('button', { name: /src\/main\/ipc\.ts/ })
    expect(chip.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(onFileClick).toHaveBeenCalledWith('src/main/ipc.ts')
    fireEvent.keyDown(chip, { key: 'Enter', ctrlKey: true })
    expect(onFileOpen).toHaveBeenCalledWith('src/main/ipc.ts')
  })
})
