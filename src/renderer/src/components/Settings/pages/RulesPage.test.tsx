// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { RulesPage } from './RulesPage'

const listSpy = vi.fn(() =>
  Promise.resolve([
    {
      name: 'team-style',
      description: 'Use tabs, not spaces.',
      activation: 'always',
      source: 'global'
    },
    {
      name: 'broken',
      description: '',
      activation: 'model',
      source: 'project',
      error: 'model activation requires a non-empty description'
    }
  ])
)

function mount(overrides = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    rules: { list: listSpy }
  }
  useAppStore.setState({
    settings: { dataPath: '/tmp' } as never,
    workspacePath: '/proj',
    ...overrides
  })
  render(<RulesPage />)
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RulesPage', () => {
  it('renders the page title', () => {
    mount()
    expect(screen.getByText('Rules')).toBeTruthy()
  })
  it('lists a row per rule with its activation mode + description', async () => {
    mount()
    expect(await screen.findByText('team-style')).toBeTruthy()
    expect(screen.getByText('Always')).toBeTruthy()
    expect(screen.getByText('Use tabs, not spaces.')).toBeTruthy()
  })
  it('shows a parse-errored rule greyed with its error, and never offers edit/delete', async () => {
    mount()
    const errorText = await screen.findByText(/requires a non-empty description/i)
    expect(errorText).toBeTruthy()
    const row = errorText.closest('.set-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(Number(row.style.opacity)).toBeLessThan(1)
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
  })
  it('a plugin-sourced rule shows a provenance badge', async () => {
    listSpy.mockResolvedValueOnce([
      {
        name: 'from-plugin',
        description: 'Bundled by a plugin.',
        activation: 'always',
        source: 'global',
        plugin: 'my-plugin'
      }
    ] as never)
    mount()
    await screen.findByText('from-plugin')
    expect(screen.getByText('Plugin: my-plugin')).toBeTruthy()
  })
})
