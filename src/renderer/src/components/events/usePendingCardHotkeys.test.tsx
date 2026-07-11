// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { usePendingCardHotkeys } from './usePendingCardHotkeys'

function Harness(props: {
  active: boolean
  onApprove: () => void
  onDeny: () => void
  onAlways?: () => void
}): React.JSX.Element {
  usePendingCardHotkeys(props)
  return <div>card</div>
}

// Matches the real hotkey contract implemented inline in the Pending* cards
// (PendingCommand et al.): '1' approves, '3' denies on a card with an
// "always allow" option (where '2' toggles that panel instead), and only the
// active (first-pending) card responds.
describe('usePendingCardHotkeys', () => {
  it('fires approve/deny only when active', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    const { rerender } = render(<Harness active onApprove={onApprove} onDeny={onDeny} />)
    fireEvent.keyDown(window, { key: '1' })
    expect(onApprove).toHaveBeenCalledTimes(1)
    rerender(<Harness active={false} onApprove={onApprove} onDeny={onDeny} />)
    fireEvent.keyDown(window, { key: '1' })
    expect(onApprove).toHaveBeenCalledTimes(1) // inactive: ignored
  })

  it('maps "2" to deny when there is no always-allow option', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(<Harness active onApprove={onApprove} onDeny={onDeny} />)
    fireEvent.keyDown(window, { key: '2' })
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  it('maps "2" to onAlways and "3" to deny when an always-allow option is present', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    const onAlways = vi.fn()
    render(<Harness active onApprove={onApprove} onDeny={onDeny} onAlways={onAlways} />)
    fireEvent.keyDown(window, { key: '2' })
    expect(onAlways).toHaveBeenCalledTimes(1)
    expect(onDeny).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '3' })
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  it('ignores keydowns while a text field has focus', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(<Harness active onApprove={onApprove} onDeny={onDeny} />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: '1' })
    expect(onApprove).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('ignores keydowns with a modifier held', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(<Harness active onApprove={onApprove} onDeny={onDeny} />)
    fireEvent.keyDown(window, { key: '1', metaKey: true })
    expect(onApprove).not.toHaveBeenCalled()
  })
})
