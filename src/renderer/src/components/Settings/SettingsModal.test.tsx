// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { SettingsModal } from './SettingsModal'

const settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  defaultModelRef: null,
  defaultPermissionMode: 'accept-edits',
  disabledBuiltins: [],
  artifactReviewPolicy: 'request-review',
  dataPath: '/tmp/data'
}

const setSpy = vi.fn((patch: Record<string, unknown>) => Promise.resolve({ ...settings, ...patch }))

beforeEach(() => {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    settings: { set: setSpy },
    permissions: { list: vi.fn(() => Promise.resolve({ userRules: [], builtins: [] })) }
  }
  useAppStore.setState({
    settingsOpen: true,
    settings: settings as never,
    providers: [],
    conversations: {}
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SettingsModal default permission mode', () => {
  it('offers the four selectable modes (never Bypass) and saves the pick', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Permissions')) // rail nav to the Permissions page
    const select = screen.getByLabelText('Default permission mode') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'ask',
      'accept-edits',
      'plan',
      'auto'
    ])
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(setSpy).toHaveBeenCalledWith({ defaultPermissionMode: 'auto' })
  })
})
