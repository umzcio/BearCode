// @vitest-environment jsdom
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { TerminalView } from './TerminalView'

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ id, active }: { id: string; active: boolean }) => (
    <div data-testid={`pane-${id}`} data-active={active} />
  )
}))

vi.stubGlobal('bearcode', {
  terminal: {
    list: vi.fn(async () => []),
    create: vi.fn(async (projectPath: string) => ({
      id: `t-${Math.random()}`,
      projectPath,
      title: 'zsh',
      createdAt: 0,
      exited: false
    })),
    close: vi.fn(async () => {})
  }
})

beforeEach(() => {
  useAppStore.setState({ terminalTabs: {}, activeTerminalTab: {} })
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('TerminalView', () => {
  it('creates an initial tab when the project has no existing sessions', async () => {
    render(<TerminalView path="/proj/a" />)
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
  })

  it('hydrates from existing main-process sessions instead of creating a new one', async () => {
    vi.mocked(window.bearcode.terminal.list).mockResolvedValueOnce([
      { id: 'existing', projectPath: '/proj/a', title: 'zsh', createdAt: 0, exited: false }
    ])
    render(<TerminalView path="/proj/a" />)
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
    expect(useAppStore.getState().terminalTabs['/proj/a'][0].id).toBe('existing')
    expect(window.bearcode.terminal.create).not.toHaveBeenCalled()
  })

  it('does not double-create a tab when the hydration effect double-invokes under StrictMode', async () => {
    // Regression test for the reviewer finding on Task 5: dev StrictMode
    // mounts every effect twice (mount -> cleanup -> mount) before yielding to
    // microtasks, so both passes of the hydration effect used to see
    // `tabs.length === 0` and both call `createTerminalTab`, spawning two real
    // pty sessions for one Terminal view. `terminal.list` resolves via a real
    // Promise (a microtask), which lands strictly after React has already run
    // both effect passes and torn down the first one's closure -- so this
    // reproduces the exact race without needing to fake timers.
    render(
      <StrictMode>
        <TerminalView path="/proj/a" />
      </StrictMode>
    )
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
    expect(window.bearcode.terminal.create).toHaveBeenCalledTimes(1)
    expect(window.bearcode.terminal.list).toHaveBeenCalledTimes(2)
  })

  it('clicking + creates another tab and makes it active', async () => {
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    fireEvent.click(screen.getByLabelText('New terminal tab'))
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(2))
  })

  it("only the active tab's pane is marked active", () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't2' }
    })
    render(<TerminalView path="/proj/a" />)
    expect(screen.getByTestId('pane-t1').dataset.active).toBe('false')
    expect(screen.getByTestId('pane-t2').dataset.active).toBe('true')
  })
})
