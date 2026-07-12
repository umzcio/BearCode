// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { BrowsePluginsModal } from './BrowsePluginsModal'

const catalogSpy = vi.fn()
const onClose = vi.fn()
const onInstalled = vi.fn()

function mount(mode?: 'plugins' | 'skills'): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    plugins: {
      catalog: catalogSpy
    }
  }
  render(<BrowsePluginsModal mode={mode} onClose={onClose} onInstalled={onInstalled} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BrowsePluginsModal', () => {
  it('defaults to plugins mode and shows every catalog entry', async () => {
    catalogSpy.mockResolvedValue([
      { name: 'a-skill', description: 'A skill.', source: 'x', marketplaceUrl: 'y', kind: 'skill' },
      {
        name: 'a-plugin',
        description: 'A plugin.',
        source: 'x',
        marketplaceUrl: 'y',
        kind: 'plugin'
      }
    ])
    mount()
    await waitFor(() => expect(screen.getByText('a-skill')).toBeTruthy())
    expect(screen.getByText('a-plugin')).toBeTruthy()
    expect(screen.getByText('Browse Plugins')).toBeTruthy()
  })

  it('in skills mode, only kind:skill entries render and the header reads Browse Skills', async () => {
    catalogSpy.mockResolvedValue([
      { name: 'a-skill', description: 'A skill.', source: 'x', marketplaceUrl: 'y', kind: 'skill' },
      {
        name: 'a-plugin',
        description: 'A plugin.',
        source: 'x',
        marketplaceUrl: 'y',
        kind: 'plugin'
      }
    ])
    mount('skills')
    await waitFor(() => expect(screen.getByText('a-skill')).toBeTruthy())
    expect(screen.queryByText('a-plugin')).toBeNull()
    expect(screen.getByText('Browse Skills')).toBeTruthy()
  })
})
