// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BearcodeApi } from '@shared/types'
import { useAppStore } from './store'

const terminal = {
  create: vi.fn(),
  close: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    bearcode: { terminal } as unknown as BearcodeApi
  })
  useAppStore.setState({ terminalTabs: {}, activeTerminalTab: {}, view: { kind: 'home' } })
})

describe('terminal tab store actions', () => {
  it('openTerminalView switches to the terminal view for a path and closes any aux pane', () => {
    useAppStore.setState({ auxSelection: { kind: 'artifact', artifactId: 'a' } })
    useAppStore.getState().openTerminalView('/proj/a')
    expect(useAppStore.getState().view).toEqual({ kind: 'terminal', path: '/proj/a' })
    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('createTerminalTab appends a tab and makes it active', async () => {
    terminal.create.mockResolvedValue({
      id: 't1',
      projectPath: '/proj/a',
      title: 'zsh',
      createdAt: 0,
      exited: false
    })
    await useAppStore.getState().createTerminalTab('/proj/a')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toEqual([
      { id: 't1', title: 'zsh', exited: false }
    ])
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t1')
  })

  it('scopes tabs independently per project path', async () => {
    terminal.create.mockResolvedValueOnce({
      id: 't1',
      projectPath: '/proj/a',
      title: 'zsh',
      createdAt: 0,
      exited: false
    })
    terminal.create.mockResolvedValueOnce({
      id: 't2',
      projectPath: '/proj/b',
      title: 'zsh',
      createdAt: 0,
      exited: false
    })
    await useAppStore.getState().createTerminalTab('/proj/a')
    await useAppStore.getState().createTerminalTab('/proj/b')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1)
    expect(useAppStore.getState().terminalTabs['/proj/b']).toHaveLength(1)
  })

  it('closeTerminalTab removes the tab and calls the IPC bridge', async () => {
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    terminal.close.mockResolvedValue(undefined)
    await useAppStore.getState().closeTerminalTab('/proj/a', 't1')
    expect(terminal.close).toHaveBeenCalledWith('t1')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toEqual([])
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBeUndefined()
  })

  it('closeTerminalTab falls back the active tab to the last remaining tab', async () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    terminal.close.mockResolvedValue(undefined)
    await useAppStore.getState().closeTerminalTab('/proj/a', 't1')
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t2')
  })

  it('setActiveTerminalTab switches the active tab for a path', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    useAppStore.getState().setActiveTerminalTab('/proj/a', 't2')
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t2')
  })

  it('markTerminalTabExited flags only the matching tab', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      }
    })
    useAppStore.getState().markTerminalTabExited('/proj/a', 't1')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toEqual([
      { id: 't1', title: 'zsh', exited: true },
      { id: 't2', title: 'zsh', exited: false }
    ])
  })
})
