// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EmptyState } from './EmptyState'
import { Loading } from './Loading'
import { ErrorCard } from './ErrorCard'

afterEach(cleanup)

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="No results" />)
    expect(screen.getByText('No results')).toBeTruthy()
  })

  it('renders an optional hint', () => {
    render(<EmptyState title="No results" hint="Try a different search" />)
    expect(screen.getByText('No results')).toBeTruthy()
    expect(screen.getByText('Try a different search')).toBeTruthy()
  })

  it('omits the hint line when none is given', () => {
    const { container } = render(<EmptyState title="No results" />)
    expect(container.querySelector('.empty-state-hint')).toBeNull()
  })
})

describe('Loading', () => {
  it('renders the default label', () => {
    render(<Loading />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('renders a custom label', () => {
    render(<Loading label="Fetching servers…" />)
    expect(screen.getByText('Fetching servers…')).toBeTruthy()
  })
})

describe('ErrorCard', () => {
  it('has role="alert"', () => {
    render(<ErrorCard>Something went wrong</ErrorCard>)
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong')
  })
})
