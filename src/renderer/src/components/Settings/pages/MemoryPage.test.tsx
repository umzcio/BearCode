// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { MemoryPage } from './MemoryPage'

const listSpy = vi.fn(() =>
  Promise.resolve({
    global: { entries: [{ scope: 'global', index: 0, text: 'prefers pnpm' }], sizeBytes: 15 },
    project: { entries: [{ scope: 'project', index: 0, text: 'uses vitest' }], sizeBytes: 14 }
  })
)
const addSpy = vi.fn(() => Promise.resolve('ok'))
const updateSpy = vi.fn(() => Promise.resolve())
const deleteSpy = vi.fn(() => Promise.resolve())
const promoteSpy = vi.fn(() => Promise.resolve())

function mount(overrides = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    memory: {
      list: listSpy,
      add: addSpy,
      update: updateSpy,
      delete: deleteSpy,
      promote: promoteSpy
    }
  }
  useAppStore.setState({
    settings: { dataPath: '/tmp' } as never,
    workspacePath: '/proj',
    ...overrides
  })
  render(<MemoryPage />)
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MemoryPage', () => {
  it('renders the page title', () => {
    mount()
    expect(screen.getByText('Memory')).toBeTruthy()
  })
  it('lists global and project entries', async () => {
    mount()
    expect(await screen.findByText('prefers pnpm')).toBeTruthy()
    expect(screen.getByText('uses vitest')).toBeTruthy()
  })
  it('hides the project section with no workspace open', async () => {
    mount({ workspacePath: null })
    await screen.findByText('prefers pnpm')
    expect(screen.queryByText('uses vitest')).toBeNull()
  })
  it('adding a memory calls add then refreshes', async () => {
    mount()
    await screen.findByText('prefers pnpm')
    fireEvent.click(screen.getAllByRole('button', { name: /add memory/i })[0])
    fireEvent.change(screen.getByLabelText(/new memory/i), { target: { value: 'likes tabs' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(addSpy).toHaveBeenCalled())
  })
  it('deleting a memory calls delete with scope + index', async () => {
    mount()
    await screen.findByText('prefers pnpm')
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i })[0])
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('global', 0, '/proj'))
  })
})
