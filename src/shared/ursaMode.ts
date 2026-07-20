import type { UrsaMode } from './types'

// Canonical ordered list of Ursa modes. The IPC guard and the ModePicker
// (Task 2) both derive from this so the union can never drift. Mirrors
// shared/effort.ts's EFFORT_LEVELS idiom.
export const URSA_MODES: readonly UrsaMode[] = ['auto', 'code', 'council', 'deep-research']

// Runtime guard for values arriving over IPC (or read back from the DB).
// Only rejects garbage; unknown/malformed values coerce to 'auto' at the
// read site (db/index.ts toMeta), never here.
export function isUrsaMode(value: unknown): value is UrsaMode {
  return typeof value === 'string' && (URSA_MODES as readonly string[]).includes(value)
}
