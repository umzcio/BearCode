import type { UrsaMode } from './types'

// Canonical ordered list of Ursa modes. The IPC guard and the ModePicker
// both derive from this so the union can never drift. Mirrors
// shared/effort.ts's EFFORT_LEVELS idiom.
export const URSA_MODES: readonly UrsaMode[] = ['code', 'council', 'deep-research', 'review']

// Runtime guard for values arriving over IPC (or read back from the DB).
// Only rejects garbage; unknown/malformed values (including the retired
// 'auto' mode) coerce to 'code' at the read site (db/index.ts toMeta),
// never here.
export function isUrsaMode(value: unknown): value is UrsaMode {
  return typeof value === 'string' && (URSA_MODES as readonly string[]).includes(value)
}
