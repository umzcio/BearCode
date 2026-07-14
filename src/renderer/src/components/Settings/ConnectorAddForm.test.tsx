// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ConnectorAddForm, EMPTY_MANUAL_DRAFT, parsePairs, isManualDraftValid } from './ConnectorAddForm'

afterEach(() => cleanup())

describe('parsePairs', () => {
  it('parses comma-separated key=value pairs', () => {
    expect(parsePairs('a=1, b=2')).toEqual({ a: '1', b: '2' })
  })
  it('ignores blank and malformed entries', () => {
    expect(parsePairs('a=1, , bogus, c=3')).toEqual({ a: '1', c: '3' })
  })
})

describe('isManualDraftValid', () => {
  it('requires a name and a url for http transport', () => {
    expect(isManualDraftValid({ ...EMPTY_MANUAL_DRAFT, transport: 'http' })).toBe(false)
    expect(
      isManualDraftValid({ ...EMPTY_MANUAL_DRAFT, transport: 'http', name: 'x', url: 'https://x' })
    ).toBe(true)
  })
  it('requires a name and a command for stdio transport', () => {
    expect(isManualDraftValid({ ...EMPTY_MANUAL_DRAFT, transport: 'stdio', name: 'x' })).toBe(false)
    expect(
      isManualDraftValid({ ...EMPTY_MANUAL_DRAFT, transport: 'stdio', name: 'x', command: 'npx' })
    ).toBe(true)
  })
})

describe('ConnectorAddForm', () => {
  it('shows the scope selector only when showScopeSelector is true', () => {
    const { rerender } = render(
      <ConnectorAddForm draft={EMPTY_MANUAL_DRAFT} onChange={vi.fn()} onSubmit={vi.fn()} showScopeSelector={true} />
    )
    expect(screen.getByLabelText('Scope')).toBeInTheDocument()
    rerender(
      <ConnectorAddForm draft={EMPTY_MANUAL_DRAFT} onChange={vi.fn()} onSubmit={vi.fn()} showScopeSelector={false} />
    )
    expect(screen.queryByLabelText('Scope')).not.toBeInTheDocument()
  })

  it('disables Add server until the draft is valid, then calls onSubmit', () => {
    const onSubmit = vi.fn()
    const onChange = vi.fn()
    const { rerender } = render(
      <ConnectorAddForm draft={EMPTY_MANUAL_DRAFT} onChange={onChange} onSubmit={onSubmit} showScopeSelector={false} />
    )
    expect(screen.getByText('Add server')).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'gh' } })
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_MANUAL_DRAFT, name: 'gh' })

    const validDraft = { ...EMPTY_MANUAL_DRAFT, name: 'gh', url: 'https://x' }
    rerender(
      <ConnectorAddForm draft={validDraft} onChange={onChange} onSubmit={onSubmit} showScopeSelector={false} />
    )
    fireEvent.click(screen.getByText('Add server'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
