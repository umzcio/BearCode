// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectSkillsTab } from './ProjectSkillsTab'

const projectSkill = {
  name: 'run-tests',
  description: 'Runs the suite.',
  source: 'project' as const,
  enabled: true,
  sizeBytes: 200,
  body: 'body content'
}
const globalSkill = {
  name: 'pdf',
  description: 'Extract PDFs.',
  source: 'global' as const,
  enabled: true,
  sizeBytes: 1200,
  body: 'body content'
}

const listSpy = vi.fn(() => Promise.resolve([projectSkill, globalSkill]))
const createSpy = vi.fn(() =>
  Promise.resolve({ name: 'new-skill', description: 'x', source: 'project', enabled: true, sizeBytes: 10, body: '' })
)
const updateSpy = vi.fn(() =>
  Promise.resolve({ ...projectSkill, description: 'Runs the suite better.' })
)
const deleteSpy = vi.fn(() => Promise.resolve())
const setEnabledSpy = vi.fn(() => Promise.resolve())

function mount(): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    skills: { list: listSpy, create: createSpy, update: updateSpy, delete: deleteSpy, setEnabled: setEnabledSpy }
  }
  render(<ProjectSkillsTab projectPath="/proj" />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectSkillsTab', () => {
  it('calls skills.list scoped to the project path on mount', async () => {
    mount()
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith('/proj'))
  })

  it('shows only project-scoped skills, never global ones', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('run-tests')).toBeInTheDocument())
    expect(screen.queryByText('pdf')).not.toBeInTheDocument()
  })

  it('does not render a Browse Skills button', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('run-tests')).toBeInTheDocument())
    expect(screen.queryByText('Browse Skills')).not.toBeInTheDocument()
  })

  it('creating a skill always uses scope: project and calls skills.create with the project path', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('+ New skill')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ New skill'))
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'new-skill' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'new-skill', description: 'x', scope: 'project' }),
        '/proj'
      )
    )
  })

  it('toggling enabled calls skills.setEnabled with source project and the project path', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('run-tests')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('switch', { name: 'Enable run-tests' }))
    expect(setEnabledSpy).toHaveBeenCalledWith('run-tests', 'project', '/proj', false)
  })

  it('shows an empty state when there are no project skills', async () => {
    listSpy.mockResolvedValueOnce([globalSkill])
    mount()
    await waitFor(() => expect(screen.getByText('No skills yet')).toBeInTheDocument())
  })
})
