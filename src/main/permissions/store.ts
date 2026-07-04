import { randomUUID } from 'crypto'
import type { AddRuleInput, PermissionRule } from '../../shared/types'
import { insertRule, listRules } from '../db'
import { BUILTIN_RULES } from './rules'

// Pure: the rules that apply to a given project = all builtins + global user
// rules + user rules scoped to THIS project. Kept pure (user rules passed in) so
// it is unit-testable without the DB.
export function mergeRules(userRules: PermissionRule[], projectPath: string | null): PermissionRule[] {
  const applicable = userRules.filter(
    (r) => r.scope === 'global' || (projectPath != null && r.scope.projectPath === projectPath)
  )
  return [...BUILTIN_RULES, ...applicable]
}

// The evaluation input for a conversation's project: builtins + this project's
// user rules, read live from the DB each call.
export function getEffectiveRules(projectPath: string | null): PermissionRule[] {
  return mergeRules(listRules(), projectPath)
}

export function addUserRule(input: AddRuleInput): void {
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
