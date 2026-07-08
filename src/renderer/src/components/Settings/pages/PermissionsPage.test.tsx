// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { PermissionsPage } from './PermissionsPage'

const baseSettings = {
  defaultPermissionMode: 'accept-edits',
  artifactReviewPolicy: 'request-review',
  fileAccessPolicy: 'deny',
  terminalAutoExec: 'auto',
  securityPreset: 'custom'
}

const setSpy = vi.fn((patch: Record<string, unknown>) =>
  Promise.resolve({ ...baseSettings, ...patch })
)

function mount(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    settings: { set: setSpy },
    permissions: { list: vi.fn(() => Promise.resolve({ userRules: [], builtins: [] })) },
    models: { list: vi.fn(() => Promise.resolve([])), manageable: vi.fn(() => Promise.resolve([])) }
  }
  useAppStore.setState({ settings: { ...baseSettings, ...overrides } as never })
  render(<PermissionsPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PermissionsPage — Agent Settings (F8)', () => {
  it('renders the three Agent Settings controls', () => {
    mount()
    expect(screen.getByLabelText('Security preset')).toBeTruthy()
    expect(screen.getByLabelText('File access policy')).toBeTruthy()
    expect(screen.getByLabelText('Terminal auto-execution')).toBeTruthy()
  })

  it('picking Full Autonomy applies the whole bundle', () => {
    mount()
    fireEvent.click(screen.getByLabelText('Security preset'))
    const opt = screen.getAllByRole('option').find((o) => o.textContent?.includes('Full Autonomy'))
    fireEvent.click(opt as HTMLElement)
    expect(setSpy).toHaveBeenCalledWith({
      defaultPermissionMode: 'auto',
      fileAccessPolicy: 'allow',
      terminalAutoExec: 'auto',
      securityPreset: 'full-autonomy'
    })
  })

  it('editing File Access to Allow persists it and re-derives the preset (custom)', () => {
    mount()
    fireEvent.click(screen.getByLabelText('File access policy'))
    const opt = screen.getAllByRole('option').find((o) => o.textContent?.includes('Allow reads'))
    fireEvent.click(opt as HTMLElement)
    // accept-edits + allow + auto is not a preset → custom.
    expect(setSpy).toHaveBeenCalledWith({ fileAccessPolicy: 'allow', securityPreset: 'custom' })
  })

  it('shows Full Autonomy as the derived preset when settings match it', () => {
    mount({ defaultPermissionMode: 'auto', fileAccessPolicy: 'allow', terminalAutoExec: 'auto' })
    const trigger = screen.getByLabelText('Security preset')
    expect(trigger.textContent).toContain('Full Autonomy')
  })

  it('still renders Artifact Review and the Default Mode escape hatch', () => {
    mount()
    expect(screen.getByLabelText('Artifact review policy')).toBeTruthy()
    expect(screen.getByLabelText('Default permission mode')).toBeTruthy()
  })

  it('editing the Default Mode carries the re-derived preset', () => {
    mount()
    fireEvent.click(screen.getByLabelText('Default permission mode'))
    const opt = screen.getAllByRole('option').find((o) => o.textContent?.includes('Auto mode'))
    fireEvent.click(opt as HTMLElement)
    // accept-edits→auto, with deny/auto → not a preset → custom.
    expect(setSpy).toHaveBeenCalledWith({ defaultPermissionMode: 'auto', securityPreset: 'custom' })
  })
})
