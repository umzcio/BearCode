// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useRovingTabs } from './useRovingTabs'

function Harness({
  disabledIds = [],
  disabledElementIds = []
}: {
  disabledIds?: string[]
  disabledElementIds?: string[]
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState('first')
  const onActivate = vi.fn((id: string) => setSelectedId(id))
  const { tablistRef, onKeyDown } = useRovingTabs({
    ids: ['first', 'disabled', 'last'],
    disabledIds,
    selectedId,
    onActivate
  })

  return (
    <div ref={tablistRef} role="tablist" aria-label="Test tabs" onKeyDown={onKeyDown}>
      {['first', 'disabled', 'last'].map((id) => (
        <button
          key={id}
          role="tab"
          data-roving-tab-id={id}
          disabled={disabledElementIds.includes(id)}
          aria-selected={selectedId === id}
          tabIndex={selectedId === id ? 0 : -1}
        >
          {id}
        </button>
      ))}
    </div>
  )
}

describe('useRovingTabs', () => {
  afterEach(cleanup)

  it('skips disabled tabs while wrapping Arrow keys and Home/End', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    render(<Harness disabledIds={['disabled']} />)
    const first = screen.getByRole('tab', { name: 'first' })
    const last = screen.getByRole('tab', { name: 'last' })
    const disabled = screen.getByRole('tab', { name: 'disabled' })

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(last).toHaveFocus()
    expect(last).toHaveAttribute('aria-selected', 'true')
    expect(disabled).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(last, { key: 'Home' })
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(last).toHaveFocus()

    fireEvent.keyDown(last, { key: 'End' })
    expect(last).toHaveFocus()
    expect(disabled).not.toHaveFocus()
  })

  it('also skips a disabled tab element when no disabled ID is supplied', () => {
    render(<Harness disabledElementIds={['disabled']} />)
    const first = screen.getByRole('tab', { name: 'first' })
    const last = screen.getByRole('tab', { name: 'last' })

    fireEvent.keyDown(first, { key: 'ArrowRight' })

    expect(last).toHaveFocus()
    expect(last).toHaveAttribute('aria-selected', 'true')
  })
})
