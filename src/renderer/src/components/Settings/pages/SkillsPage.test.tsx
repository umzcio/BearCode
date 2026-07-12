// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { SkillsPage } from './SkillsPage'

const listSpy = vi.fn(() =>
  Promise.resolve([
    {
      name: 'pdf',
      description: 'Extract PDFs.',
      source: 'global',
      enabled: true,
      sizeBytes: 1200,
      body: 'Full pdf skill body content that must survive an edit.'
    },
    {
      name: 'broken',
      description: '',
      source: 'project',
      enabled: true,
      sizeBytes: 40,
      error: 'SKILL.md requires a non-empty description',
      body: ''
    }
  ])
)
const createSpy = vi.fn(() =>
  Promise.resolve({
    name: 'new-skill',
    description: 'x',
    source: 'project',
    enabled: true,
    sizeBytes: 10
  })
)
const updateSpy = vi.fn(() =>
  Promise.resolve({
    name: 'pdf',
    description: 'Extract PDFs better.',
    source: 'global',
    enabled: true,
    sizeBytes: 1300
  })
)
const deleteSpy = vi.fn(() => Promise.resolve())
const setEnabledSpy = vi.fn(() => Promise.resolve())

function mount(overrides = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    skills: {
      list: listSpy,
      create: createSpy,
      update: updateSpy,
      delete: deleteSpy,
      setEnabled: setEnabledSpy
    }
  }
  useAppStore.setState({
    settings: { dataPath: '/tmp' } as never,
    workspacePath: '/proj',
    ...overrides
  })
  render(<SkillsPage />)
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillsPage', () => {
  it('renders the page title', () => {
    mount()
    expect(screen.getByText('Skills')).toBeTruthy()
  })
  it('lists a row per skill with a scope badge + size', async () => {
    mount()
    expect(await screen.findByText('pdf')).toBeTruthy()
    expect(screen.getByText(/global/i)).toBeTruthy()
    expect(screen.getByText(/Extract PDFs\./)).toBeTruthy()
  })
  it('shows a parse-errored skill greyed with its error', async () => {
    mount()
    const errorText = await screen.findByText(/requires a non-empty description/i)
    expect(errorText).toBeTruthy()
    const row = errorText.closest('.set-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.style.opacity).not.toBe('')
    expect(Number(row.style.opacity)).toBeLessThan(1)
  })
  it('editing a skill pre-fills its existing body instead of wiping it', async () => {
    mount()
    await screen.findByText('pdf')
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0])
    const bodyField = screen.getByLabelText(/^body$/i) as HTMLTextAreaElement
    expect(bodyField.value).toBe('Full pdf skill body content that must survive an edit.')
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'pdf',
        expect.objectContaining({ body: 'Full pdf skill body content that must survive an edit.' }),
        '/proj'
      )
    )
  })
  it('toggling a skill calls setEnabled', async () => {
    mount()
    await screen.findByText('pdf')
    fireEvent.click(screen.getByRole('switch', { name: /enable pdf/i }))
    expect(setEnabledSpy).toHaveBeenCalledWith('pdf', 'global', '/proj', false)
  })
  it('creating a skill calls create then refreshes', async () => {
    mount()
    await screen.findByText('pdf')
    fireEvent.click(screen.getByRole('button', { name: /new skill/i }))
    fireEvent.change(screen.getByLabelText(/skill name/i), { target: { value: 'new-skill' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() => expect(createSpy).toHaveBeenCalled())
  })
  it('delete requires a typed confirmation', async () => {
    mount()
    await screen.findByText('pdf')
    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
    // typed-confirm: Delete disabled until the name is typed
    const confirm = screen.getByLabelText(/type .*pdf.* to confirm/i)
    fireEvent.change(confirm, { target: { value: 'pdf' } })
    fireEvent.click(screen.getByRole('button', { name: /delete skill/i }))
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('pdf', 'global', '/proj'))
  })
  it('a plugin-sourced skill shows a provenance badge and has read-only edit/delete', async () => {
    listSpy.mockResolvedValueOnce([
      {
        name: 'from-plugin',
        description: 'Bundled by a plugin.',
        source: 'global',
        enabled: true,
        sizeBytes: 50,
        body: 'body',
        plugin: 'my-plugin'
      }
    ] as never)
    mount()
    await screen.findByText('from-plugin')
    expect(screen.getByText('Plugin: my-plugin')).toBeTruthy()
    const editBtn = screen.getByRole('button', { name: /^edit$/i })
    const deleteBtn = screen.getByRole('button', { name: /^delete$/i })
    expect(editBtn.hasAttribute('disabled')).toBe(true)
    expect(deleteBtn.hasAttribute('disabled')).toBe(true)
  })
})
