// Shared form validators. Centralizes the kebab-case name rule that was
// previously copy-pasted (KEBAB_PATTERN) across SkillsPage, HooksPage, and
// MemoryPage -- new call sites should import from here.
export const KEBAB_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isKebabName(s: string): boolean {
  return KEBAB_PATTERN.test(s)
}

export const KEBAB_HINT = 'Lowercase letters, numbers, and dashes only — e.g. my-name.'
