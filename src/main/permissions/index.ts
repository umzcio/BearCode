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
//
// SECURITY (design §6): mode === 'bypass' is the ONE mode that skips the rules
// engine entirely -- no deny, no builtin .git/.env protection, no ask/prompt.
// It returns 'run' BEFORE getEffectiveRules/evaluateCommand are ever called.
// Every OTHER mode keeps deny-wins. Do not route any non-bypass mode around
// this engine, and never make 'bypass' a global default (settings.ts rejects it
// on write).
export function evaluateCommandForConversation(
  command: string,
  conversationId: string,
  projectPath: string | null
): CommandDecision {
  const mode = resolveConversationMode(conversationId)
  if (mode === 'bypass') return 'run'
  // F8: terminalAutoExec (global) can only TIGHTEN the auto-mode fallback; it is
  // read live like mode/rules. Bypass already returned above, unaffected.
  return evaluateCommand(
    command,
    mode,
    getEffectiveRules(projectPath),
    getSettings().terminalAutoExec ?? 'auto'
  )
}

// The file-write gate's single entry point: rules first (deny/ask), then the
// MODE as the fallback (design §4.1 -- plan is read-only). Reads mode + rules
// live per call.
//
// SECURITY (design §6): mirrors the command path -- mode === 'bypass' returns
// 'apply' BEFORE getEffectiveRules/evaluateEdit are called, skipping the entire
// engine (including builtin .env/.git denies). Every other mode keeps
// deny-wins. See the loud note on evaluateCommandForConversation above.
export function evaluateEditForConversation(
  relPath: string,
  conversationId: string,
  projectPath: string
): EditDecision {
  const mode = resolveConversationMode(conversationId)
  if (mode === 'bypass') return 'apply'
  return evaluateEdit(relPath, mode, getEffectiveRules(projectPath))
}
