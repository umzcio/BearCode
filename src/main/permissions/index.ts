// Public surface of the permissions module (Bb1 mode resolution + Bb2 rules).
import type { CommandDecision, PermissionMode } from '../../shared/types'
import { getConversationMeta } from '../db'
import { getSettings } from '../settings'
import { evaluateCommand } from './rules'
import { getEffectiveRules } from './store'

export { evaluateCommand, matchesCommand, BUILTIN_RULES } from './rules'
export { getEffectiveRules, addUserRule, mergeRules } from './store'

// Reads live so a mode change (e.g. an approval-card action) takes effect for the
// rest of the running turn (Bb1).
export function resolveConversationMode(conversationId: string): PermissionMode {
  return getConversationMeta(conversationId)?.permissionMode ?? getSettings().defaultPermissionMode
}

// The run_command gate's single entry point: rules first (deny/allow/ask), mode
// as the fallback. Reads mode + rules live per call.
export function evaluateCommandForConversation(
  command: string,
  conversationId: string,
  projectPath: string | null
): CommandDecision {
  const mode = resolveConversationMode(conversationId)
  return evaluateCommand(command, mode, getEffectiveRules(projectPath))
}
