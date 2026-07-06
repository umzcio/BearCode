// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useCmdHeld } from './useCmdHeld'

function Probe(): React.JSX.Element {
  const held = useCmdHeld()
  return <div>{held ? 'held' : 'not-held'}</div>
}

afterEach(cleanup)

describe('useCmdHeld', () => {
  it('is false until Meta/Ctrl is held', () => {
    render(<Probe />)
    expect(screen.getByText('not-held')).toBeTruthy()
  })

  it('becomes true on a Meta keydown, false again on keyup', () => {
    render(<Probe />)
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    expect(screen.getByText('held')).toBeTruthy()
    fireEvent.keyUp(window, { key: 'Meta', metaKey: false })
    expect(screen.getByText('not-held')).toBeTruthy()
  })

  it('resets to false on window blur', () => {
    render(<Probe />)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    expect(screen.getByText('held')).toBeTruthy()
    fireEvent.blur(window)
    expect(screen.getByText('not-held')).toBeTruthy()
  })
})
