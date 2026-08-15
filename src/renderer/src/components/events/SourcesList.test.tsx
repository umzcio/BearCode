// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SourcesList } from './SourcesList'

afterEach(cleanup)

describe('SourcesList', () => {
  it("renders 1-based numbered links matching the answer's [n] markers", () => {
    render(
      <SourcesList
        citations={[
          { url: 'https://www.umt.edu/it/about', title: 'UM IT Leadership' },
          { url: 'https://example.org/profile' }
        ]}
      />
    )
    expect(screen.getByText('Sources')).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute('href')).toBe('https://www.umt.edu/it/about')
    expect(links[0].textContent).toContain('1')
    expect(links[0].textContent).toContain('UM IT Leadership')
    // umt.edu appears as the domain suffix on the titled row
    expect(links[0].textContent).toContain('umt.edu')
    // An untitled citation falls back to its domain as the text
    expect(links[1].textContent).toContain('2')
    expect(links[1].textContent).toContain('example.org')
    // External-open semantics: target=_blank routes through setWindowOpenHandler
    expect(links[0].getAttribute('target')).toBe('_blank')
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(<SourcesList citations={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('starts open and collapses/expands via the Sources disclosure', () => {
    const { container } = render(<SourcesList citations={[{ url: 'https://a.example' }]} />)
    const toggle = screen.getByRole('button', { name: 'Sources' })
    const reveal = container.querySelector('.ms-sources-reveal')!
    // Open by default: the list is visible exactly as before the disclosure existed
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(reveal.className).toContain('is-open')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(reveal.className).not.toContain('is-open')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(reveal.className).toContain('is-open')
  })
})
