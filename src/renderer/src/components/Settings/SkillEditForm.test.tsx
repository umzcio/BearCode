// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SkillEditForm, SkillRow, emptyDraft, fmtSize, isSkillDraftValid } from './SkillEditForm'

afterEach(() => cleanup())

describe('fmtSize', () => {
  it('formats bytes under 1024 as B', () => expect(fmtSize(40)).toBe('40 B'))
  it('formats 1024+ as KB', () => expect(fmtSize(1200)).toBe('1.2 KB'))
})

describe('isSkillDraftValid', () => {
  it('requires a kebab-case name and a description', () => {
    expect(isSkillDraftValid(emptyDraft('project'))).toBe(false)
    expect(
      isSkillDraftValid({ ...emptyDraft('project'), name: 'run-tests', description: 'x' })
    ).toBe(true)
    expect(
      isSkillDraftValid({ ...emptyDraft('project'), name: 'Not Kebab', description: 'x' })
    ).toBe(false)
  })
})

describe('SkillEditForm', () => {
  it('shows the scope selector only when showScopeSelector is true', () => {
    const { rerender } = render(
      <SkillEditForm draft={emptyDraft('project')} onChange={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} showScopeSelector={true} />
    )
    expect(screen.getByLabelText('Skill scope')).toBeInTheDocument()
    rerender(
      <SkillEditForm draft={emptyDraft('project')} onChange={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} showScopeSelector={false} />
    )
    expect(screen.queryByLabelText('Skill scope')).not.toBeInTheDocument()
  })

  it('disables Create until valid, then calls onSubmit', () => {
    const onSubmit = vi.fn()
    render(
      <SkillEditForm
        draft={{ ...emptyDraft('project'), name: 'run-tests', description: 'runs the suite' }}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        showScopeSelector={false}
      />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('SkillRow', () => {
  const entry = {
    name: 'pdf',
    description: 'Extract PDFs.',
    source: 'project' as const,
    enabled: true,
    sizeBytes: 1200,
    body: 'body'
  }

  it('hides the source badge when showSourceBadge is false', () => {
    render(
      <SkillRow
        entry={entry}
        showSourceBadge={false}
        pendingDelete={false}
        confirmText=""
        onConfirmTextChange={vi.fn()}
        onToggleEnabled={vi.fn()}
        onEdit={vi.fn()}
        onStartDelete={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCancelDelete={vi.fn()}
      />
    )
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
  })

  it('calls onEdit and onStartDelete', () => {
    const onEdit = vi.fn()
    const onStartDelete = vi.fn()
    render(
      <SkillRow
        entry={entry}
        showSourceBadge={true}
        pendingDelete={false}
        confirmText=""
        onConfirmTextChange={vi.fn()}
        onToggleEnabled={vi.fn()}
        onEdit={onEdit}
        onStartDelete={onStartDelete}
        onConfirmDelete={vi.fn()}
        onCancelDelete={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Edit'))
    expect(onEdit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Delete'))
    expect(onStartDelete).toHaveBeenCalledTimes(1)
  })
})
