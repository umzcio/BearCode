// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { OutsideAccessCard } from './OutsideAccessCard'
import { useAppStore } from '../state/store'
afterEach(cleanup)
beforeEach(() => {
  useAppStore.setState({
    workspacePath: '/proj',
    outsideAccess: { policy: 'ask', allowed: [], denied: [], pending: ['/etc/hosts'] },
    allowOutside: vi.fn(async () => {}),
    denyOutside: vi.fn(async () => {})
  } as never)
})
describe('OutsideAccessCard', () => {
  it('lists each pending path with Allow/Deny', () => {
    render(<OutsideAccessCard />)
    expect(screen.getByText('/etc/hosts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /allow this path/i })).toBeTruthy()
  })
  it('renders nothing when no pending', () => {
    useAppStore.setState({
      outsideAccess: { policy: 'ask', allowed: [], denied: [], pending: [] }
    } as never)
    const { container } = render(<OutsideAccessCard />)
    expect(container.firstChild).toBeNull()
  })
  it('Allow calls allowOutside with the path', () => {
    const allowOutside = vi.fn(async () => {})
    useAppStore.setState({ allowOutside } as never)
    render(<OutsideAccessCard />)
    fireEvent.click(screen.getByRole('button', { name: /allow this path/i }))
    expect(allowOutside).toHaveBeenCalledWith('/etc/hosts')
  })
})
