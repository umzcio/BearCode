import type { PermissionMode } from './types'

// Canonical list of every PermissionMode value. The set-mode IPC guard and the
// renderer's ModePicker both derive from this so the union can never drift.
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'ask',
  'accept-edits',
  'plan',
  'auto',
  'bypass'
]

// Runtime guard for values arriving over IPC. All five modes are valid here;
// the Bypass *UX* guard lives in the renderer. This only rejects garbage.
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

// The four modes valid as a DEFAULT (global or per-project). 'bypass' is
// per-conversation only and must NEVER be a default (design §5) — a hand-edited
// settings.json / DB column carrying it must coerce away, not persist. Use this
// (never isPermissionMode) wherever a stored DEFAULT mode is validated.
export const SELECTABLE_DEFAULT_MODES: readonly PermissionMode[] = [
  'ask',
  'accept-edits',
  'plan',
  'auto'
]
export function isSelectableDefaultMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (SELECTABLE_DEFAULT_MODES as readonly string[]).includes(value)
}
