// F8 — the pure mapping between a Security Preset and the three primitive
// settings it bundles. A preset is a friendly name for a specific combination
// of the EXISTING primitives (defaultPermissionMode + fileAccessPolicy +
// terminalAutoExec); editing any one primitive away from a preset's values
// makes the combination read as 'custom'. No side effects — unit-tested.
import type {
  AppSettings,
  FileAccessPolicy,
  PermissionMode,
  SecurityPreset,
  TerminalAutoExec
} from './types'

export interface PresetShape {
  defaultPermissionMode: PermissionMode
  fileAccessPolicy: FileAccessPolicy
  terminalAutoExec: TerminalAutoExec
}

// The two concrete presets. 'custom' has no fixed values (the user sets each).
export const PRESET_VALUES: Record<'default' | 'full-autonomy', PresetShape> = {
  default: {
    defaultPermissionMode: 'ask',
    fileAccessPolicy: 'ask',
    terminalAutoExec: 'require-review'
  },
  'full-autonomy': {
    defaultPermissionMode: 'auto',
    fileAccessPolicy: 'allow',
    terminalAutoExec: 'auto'
  }
}

// The settings patch a preset selection applies. 'custom' → no change (the user
// edits the individual controls); the caller keeps the current primitives.
export function presetToSettings(preset: SecurityPreset): Partial<PresetShape> {
  if (preset === 'custom') return {}
  return { ...PRESET_VALUES[preset] }
}

// Which preset the current primitive settings represent — an EXACT match on all
// three fields, else 'custom'. This is the single source of truth for the
// preset the UI displays, so the stored securityPreset can never drift from the
// primitives it claims to describe.
export function settingsToPreset(
  s: Pick<AppSettings, 'defaultPermissionMode' | 'fileAccessPolicy' | 'terminalAutoExec'>
): SecurityPreset {
  const fileAccessPolicy = s.fileAccessPolicy ?? 'deny'
  const terminalAutoExec = s.terminalAutoExec ?? 'auto'
  for (const name of ['default', 'full-autonomy'] as const) {
    const v = PRESET_VALUES[name]
    if (
      s.defaultPermissionMode === v.defaultPermissionMode &&
      fileAccessPolicy === v.fileAccessPolicy &&
      terminalAutoExec === v.terminalAutoExec
    ) {
      return name
    }
  }
  return 'custom'
}
