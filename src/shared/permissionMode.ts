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
