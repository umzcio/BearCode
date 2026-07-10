import { randomUUID } from 'crypto'
import type { AddRuleInput, PermissionRule, PermissionRulesInfo } from '../../shared/types'
import { deleteRule, insertRule, listRules } from '../db'
import type { RuleScope } from '../../shared/types'
import { getSettings, setSettings } from '../settings'
import { BUILTIN_RULES } from './rules'

// Pure: the rules that apply to a given project = enabled builtins + global user
// rules + user rules scoped to THIS project. Kept pure (user rules and the
// disabled-builtin ids passed in) so it is unit-testable without the DB.
//
// SECURITY (design 4.3): the disabled filter is id-exact and runs over
// BUILTIN_RULES only -- an unknown id is inert, disabling one builtin can never
// drop a sibling, and user rules (including user denies) are structurally
// untouched.
export function mergeRules(
  userRules: PermissionRule[],
  projectPath: string | null,
  disabledBuiltinIds: readonly string[] = []
): PermissionRule[] {
  const activeBuiltins = BUILTIN_RULES.filter((r) => !disabledBuiltinIds.includes(r.id))
  const applicable = userRules.filter(
    (r) => r.scope === 'global' || (projectPath != null && r.scope.projectPath === projectPath)
  )
  return [...activeBuiltins, ...applicable]
}

// The evaluation input for a conversation's project: enabled builtins + this
// project's user rules, read live (DB + settings cache) each call -- a rule
// deleted or a builtin toggled in the manager takes effect on the very next
// evaluation, no restart, no cache to invalidate.
export function getEffectiveRules(projectPath: string | null): PermissionRule[] {
  return mergeRules(listRules(), projectPath, getSettings().disabledBuiltins)
}

function sameScope(a: RuleScope, b: RuleScope): boolean {
  if (a === 'global' || b === 'global') return a === b
  return a.projectPath === b.projectPath
}

export function addUserRule(input: AddRuleInput): void {
  // Dedup by (scope, action, match): re-setting an effect for the same subject
  // REPLACES the prior rule rather than stacking a second. Without this, the
  // Connectors per-tool Allow/Ask/Deny control (and any repeated add) left a
  // stale rule behind -- e.g. flipping Allow->Ask kept BOTH, and since
  // evaluate* checks allow before ask the decision stayed 'run' while the UI
  // showed "Ask". Effects can now only be changed, never silently shadowed.
  for (const existing of listRules()) {
    if (
      existing.source === 'user' &&
      existing.action === input.action &&
      existing.match === input.match &&
      sameScope(existing.scope, input.scope)
    ) {
      deleteRule(existing.id)
    }
  }
  const rule: PermissionRule = {
    id: randomUUID(),
    scope: input.scope,
    action: input.action,
    match: input.match,
    effect: input.effect,
    source: 'user'
  }
  insertRule(rule)
}

// Deletes a user rule by id. Builtins never live in the DB (design 4.5), so a
// builtin id here is a harmless no-op; disabling builtins goes through
// setBuiltinDisabled instead.
export function deleteUserRule(id: string): void {
  deleteRule(id)
}

// The manager UI's read model: user rules verbatim plus every builtin paired
// with its disabled flag, so a disabled builtin stays visible (never silently
// un-deniable -- the user always sees it flagged off and can re-enable it).
export function listRulesInfo(): PermissionRulesInfo {
  const disabled = getSettings().disabledBuiltins
  return {
    userRules: listRules(),
    builtins: BUILTIN_RULES.map((rule) => ({ rule, disabled: disabled.includes(rule.id) }))
  }
}

// Pure toggle over the persisted id list: dedupes, and refuses ids that are not
// a shipped builtin (returns a copy unchanged) so garbage can never accumulate
// in settings.json through this path.
export function toggleDisabledBuiltin(
  current: readonly string[],
  id: string,
  disabled: boolean
): string[] {
  if (!BUILTIN_RULES.some((r) => r.id === id)) return [...current]
  const without = current.filter((x) => x !== id)
  return disabled ? [...without, id] : without
}

// Persisted app-level, not per-project: settings.json via setSettings (the
// AppSettings pattern), so the choice survives restart and is visible in the
// manager. Always writes a NEW array (toggleDisabledBuiltin never mutates), so
// the DEFAULTS array in settings.ts is never aliased-and-mutated.
//
// Throws on an unknown builtin id rather than warning-and-returning: this is
// the function the IPC handler calls directly, so a throw here surfaces to
// the renderer as a rejected promise (Task 1 review) instead of a silent
// no-op the caller has no way to observe.
export function setBuiltinDisabled(id: string, disabled: boolean): void {
  if (!BUILTIN_RULES.some((r) => r.id === id)) {
    throw new Error(`setBuiltinDisabled: unknown builtin id "${id}"`)
  }
  setSettings({
    disabledBuiltins: toggleDisabledBuiltin(getSettings().disabledBuiltins, id, disabled)
  })
}
