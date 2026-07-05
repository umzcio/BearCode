// Public surface of the permissions module (Bb1 mode resolution + Bb2 rules +
// Bb3 edit gating).
import type { CommandDecision, EditDecision, PermissionMode } from '../../shared/types'
import { getConversationMeta } from '../db'
import { getSettings } from '../settings'
import { evaluateCommand, evaluateEdit } from './rules'
import { getEffectiveRules } from './store'

export {
  evaluateCommand,
  matchesCommand,
  evaluateEdit,
  matchesEditPath,
  BUILTIN_RULES
} from './rules'
export {
  getEffectiveRules,
  addUserRule,
  mergeRules,
  deleteUserRule,
  listRulesInfo,
  setBuiltinDisabled,
  toggleDisabledBuiltin
} from './store'

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

// The file-write gate's single entry point: rules first (deny/ask), then the
// MODE as the fallback (design §4.1 -- plan is read-only, so mode now
// participates in edit decisions too). Reads mode + rules live per call, same
// as the command path.
export function evaluateEditForConversation(
  relPath: string,
  conversationId: string,
  projectPath: string
): EditDecision {
  const mode = resolveConversationMode(conversationId)
  return evaluateEdit(relPath, mode, getEffectiveRules(projectPath))
}
