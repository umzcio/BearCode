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

  it('renders each tab as a div[role=button] with a real, standalone close <button> (no nested <button>s)', () => {
    // Regression test for the interactive-in-interactive fix: the outer tab
    // used to be a real <button> with a <span role="button"> close control
    // nested inside it (invalid HTML). It's now a <div role="button"
    // tabIndex={0}> wrapping a real <button> close control, mirroring
    // ProjectsIndex.tsx's .pidx-row pattern.
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    const { container } = render(<TerminalView path="/proj/a" />)
    const tab = container.querySelector('.terminal-tab')
    expect(tab?.tagName).toBe('DIV')
    expect(tab?.getAttribute('role')).toBe('button')
    expect(tab?.getAttribute('tabindex')).toBe('0')
    const closeButton = screen.getByLabelText('Close terminal tab')
    expect(closeButton.tagName).toBe('BUTTON')
    // No <button> should ever be nested inside another <button>.
    expect(container.querySelectorAll('button button')).toHaveLength(0)
  })

  it('pressing Enter on an inactive tab activates it (keyboard parity with click)', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'bash', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    const tab2 = screen.getByText('bash').closest('.terminal-tab') as HTMLElement
    fireEvent.keyDown(tab2, { key: 'Enter' })
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t2')
  })

  it('pressing Space on an inactive tab activates it (keyboard parity with click)', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'bash', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    const tab2 = screen.getByText('bash').closest('.terminal-tab') as HTMLElement
    fireEvent.keyDown(tab2, { key: ' ' })
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t2')
  })

  it('pressing Enter while focus is on the nested close button does not bubble up and activate the tab', () => {
    // Guards the `e.target !== e.currentTarget` check in the tab's onKeyDown
    // -- a keydown that bubbles up from the nested close button must not
    // also be treated as activation of the tab it lives in.
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'bash', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    const closeButtons = screen.getAllByLabelText('Close terminal tab')
    fireEvent.keyDown(closeButtons[1], { key: 'Enter' })
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t1')
  })

  it('clicking the close button closes that tab without also activating it', async () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'bash', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    const closeButtons = screen.getAllByLabelText('Close terminal tab')
    fireEvent.click(closeButtons[1])
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
    expect(useAppStore.getState().terminalTabs['/proj/a'][0].id).toBe('t1')
    // The closed tab wasn't active, so the active tab must be unchanged --
    // e.stopPropagation() on the close button's onClick must still prevent
    // the parent tab's onClick (setActiveTerminalTab) from also firing.
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t1')
  })

  it('shows a persistent notice that the terminal is not sandboxed', async () => {
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    expect(await screen.findByText('Unsandboxed')).toBeInTheDocument()
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

  it('shows an error alert (not a blank view) when the initial hydration list() rejects', async () => {
    vi.mocked(window.bearcode.terminal.list).mockRejectedValueOnce(new Error('boom: no such folder'))
    render(<TerminalView path="/proj/a" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom: no such folder')
    // The failed hydration must not have silently spawned a tab either.
    expect(useAppStore.getState().terminalTabs['/proj/a'] ?? []).toHaveLength(0)
  })

  it('shows an error alert when the auto-create-on-hydrate call rejects', async () => {
    vi.mocked(window.bearcode.terminal.create).mockRejectedValueOnce(new Error('spawn failed'))
    render(<TerminalView path="/proj/a" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('spawn failed')
  })

  it("a fresh mount for a different path never carries over a previous path's stale error (this is what the App.tsx remount key relies on)", async () => {
    // Project A: hydration fails, error banner shows.
    vi.mocked(window.bearcode.terminal.list).mockRejectedValueOnce(new Error('boom: project A'))
    const { unmount } = render(<TerminalView path="/proj/a" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom: project A')

    // Simulate the App.tsx remount that happens when the `main-view` wrapper's
    // key changes from `terminal:/proj/a` to `terminal:/proj/b` -- a full
    // unmount of the old instance, then a fresh mount of a new one for the new
    // path. Project B already has cached tabs in the store from an earlier
    // visit this session, and its own hydration succeeds cleanly.
    unmount()
    useAppStore.setState({
      terminalTabs: { '/proj/b': [{ id: 'b1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/b': 'b1' }
    })
    render(<TerminalView path="/proj/b" />)

    // The fresh instance must show Project B's working terminal, not Project
    // A's stale error banner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('pane-b1')).toBeInTheDocument()
  })

  it('shows the shared empty state (not a blank pane) after the user closes every open tab', async () => {
    // This path already had a tab at mount, so the hydration effect's
    // early-return branch runs (no list()/create() involved) and marks
    // hydration complete immediately. Simulate the user closing that last
    // tab -- `tabs` drops to zero with no error, which is exactly the
    // "nothing left to show" case the empty state covers.
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    expect(screen.queryByText('No terminal sessions')).not.toBeInTheDocument()

    useAppStore.setState({ terminalTabs: { '/proj/a': [] }, activeTerminalTab: { '/proj/a': undefined } })
    expect(await screen.findByText('No terminal sessions')).toBeInTheDocument()
  })

  it('clicking + surfaces an error alert instead of an unhandled rejection when create fails', async () => {
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    vi.mocked(window.bearcode.terminal.create).mockRejectedValueOnce(new Error('too many terminals'))
    render(<TerminalView path="/proj/a" />)
    fireEvent.click(screen.getByLabelText('New terminal tab'))
    expect(await screen.findByRole('alert')).toHaveTextContent('too many terminals')
    // The existing tab/pane must still be there -- a failed second create
    // must not tear down what was already running.
    expect(screen.getByTestId('pane-t1')).toBeInTheDocument()
  })

  describe('tab open/close motion (plan 005)', () => {
    function stubMatchMedia(reduce: boolean): void {
      vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
          matches: query === '(prefers-reduced-motion: reduce)' ? reduce : false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        }))
      )
    }

    beforeEach(() => {
      stubMatchMedia(false)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('marks a closing tab data-state="closing" and defers the actual removal by TAB_CLOSE_MS (150ms)', async () => {
      vi.useFakeTimers()
      useAppStore.setState({
        terminalTabs: {
          '/proj/a': [
            { id: 't1', title: 'zsh', exited: false },
            { id: 't2', title: 'bash', exited: false }
          ]
        },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      const { container } = render(<TerminalView path="/proj/a" />)
      const closeButtons = screen.getAllByLabelText('Close terminal tab')

      fireEvent.click(closeButtons[1])

      // Still present in the store and DOM immediately after the click --
      // only its data-state flips to 'closing', the store removal is deferred.
      expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(2)
      const tabsBefore = container.querySelectorAll('.terminal-tab')
      expect(tabsBefore[0].getAttribute('data-state')).toBe('open')
      expect(tabsBefore[1].getAttribute('data-state')).toBe('closing')

      await vi.advanceTimersByTimeAsync(149)
      expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1)
      expect(useAppStore.getState().terminalTabs['/proj/a'][0].id).toBe('t1')
    })

    it('closes immediately, skipping the deferred animation, under prefers-reduced-motion', async () => {
      stubMatchMedia(true)
      useAppStore.setState({
        terminalTabs: {
          '/proj/a': [
            { id: 't1', title: 'zsh', exited: false },
            { id: 't2', title: 'bash', exited: false }
          ]
        },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      render(<TerminalView path="/proj/a" />)
      const closeButtons = screen.getAllByLabelText('Close terminal tab')

      fireEvent.click(closeButtons[1])
      // No deferral under reduced motion -- real timers are still active in
      // this test, so just await the store update directly.
      await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
      expect(useAppStore.getState().terminalTabs['/proj/a'][0].id).toBe('t1')
    })

    it('closes immediately when only the in-app data-motion="reduced" attribute is set (OS matchMedia stays false)', async () => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      useAppStore.setState({
        terminalTabs: {
          '/proj/a': [
            { id: 't1', title: 'zsh', exited: false },
            { id: 't2', title: 'bash', exited: false }
          ]
        },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      render(<TerminalView path="/proj/a" />)
      const closeButtons = screen.getAllByLabelText('Close terminal tab')

      fireEvent.click(closeButtons[1])
      // No deferral -- takes the immediate-removal path even though
      // stubMatchMedia(false) is still active from the outer beforeEach.
      await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
      expect(useAppStore.getState().terminalTabs['/proj/a'][0].id).toBe('t1')

      document.documentElement.removeAttribute('data-motion')
    })

    it('a tab freshly created via the + button starts as data-state="open" (mount motion is CSS-only via @starting-style)', async () => {
      useAppStore.setState({
        terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      const { container } = render(<TerminalView path="/proj/a" />)
      fireEvent.click(screen.getByLabelText('New terminal tab'))
      await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(2))
      const tabs = container.querySelectorAll('.terminal-tab')
      expect(tabs[1].getAttribute('data-state')).toBe('open')
    })

    it('clicking close twice on the same tab within TAB_CLOSE_MS only defers one closeTerminalTab call', async () => {
      // Regression test for the reviewer's double-close nit: handleCloseTab
      // must no-op once a tab is already in closingIds, so a double-click (or
      // two events racing in the same 150ms window) doesn't schedule a second
      // timer/closeTerminalTab call.
      vi.useFakeTimers()
      useAppStore.setState({
        terminalTabs: {
          '/proj/a': [
            { id: 't1', title: 'zsh', exited: false },
            { id: 't2', title: 'bash', exited: false }
          ]
        },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      render(<TerminalView path="/proj/a" />)
      const closeButtons = screen.getAllByLabelText('Close terminal tab')

      fireEvent.click(closeButtons[1])
      fireEvent.click(closeButtons[1])

      await vi.advanceTimersByTimeAsync(150)
      expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1)
      expect(vi.mocked(window.bearcode.terminal.close)).toHaveBeenCalledTimes(1)
    })

    it('unmounting while a close timer is pending does not throw or leak a late setState', async () => {
      // Regression test for the reviewer's timer-cleanup finding: the pending
      // window.setTimeout from handleCloseTab must be cleared on unmount
      // (mirrors useAnimatedUnmount.ts's useEffect cleanup), not left to fire
      // against a torn-down component.
      vi.useFakeTimers()
      const clearSpy = vi.spyOn(window, 'clearTimeout')
      useAppStore.setState({
        terminalTabs: {
          '/proj/a': [
            { id: 't1', title: 'zsh', exited: false },
            { id: 't2', title: 'bash', exited: false }
          ]
        },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      const { unmount } = render(<TerminalView path="/proj/a" />)
      const closeButtons = screen.getAllByLabelText('Close terminal tab')
      fireEvent.click(closeButtons[1])

      expect(() => unmount()).not.toThrow()
      expect(clearSpy).toHaveBeenCalled()

      // Advancing timers past TAB_CLOSE_MS after unmount must not throw either
      // (no setState-on-unmounted-component warning path reachable).
      await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow()
      clearSpy.mockRestore()
    })

    it('unmounting while a close timer is pending still flushes the deferred close (not just cancels it)', async () => {
      // Regression test: clearing the pending JS timeout on unmount must not
      // silently cancel the close it was deferring -- the tab's pty/session
      // would survive and reappear next time this path's Terminal view opens.
      // The cleanup must fire closeTerminalTab for every still-pending tab
      // instead of dropping it.
      vi.useFakeTimers()
      useAppStore.setState({
        terminalTabs: {
          '/proj/a': [
            { id: 't1', title: 'zsh', exited: false },
            { id: 't2', title: 'bash', exited: false }
          ]
        },
        activeTerminalTab: { '/proj/a': 't1' }
      })
      const { unmount } = render(<TerminalView path="/proj/a" />)
      const closeButtons = screen.getAllByLabelText('Close terminal tab')
      fireEvent.click(closeButtons[1])

      // Not yet closed -- still mid-fade when we navigate away.
      expect(vi.mocked(window.bearcode.terminal.close)).not.toHaveBeenCalled()

      unmount()

      // The deferred close must have been flushed synchronously as part of
      // the unmount cleanup, not dropped. `waitFor`'s real-timer polling
      // doesn't apply here (fake timers are active) -- just flush the
      // microtask queue the mocked async close() resolves on.
      await vi.advanceTimersByTimeAsync(0)
      expect(window.bearcode.terminal.close).toHaveBeenCalledWith('t2')
    })
  })
})
