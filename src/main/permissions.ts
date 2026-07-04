// The single source the run_command gate reads for a conversation's permission
// mode (Bb1). Reads live so a mode change (e.g. "always allow" -> auto) takes
// effect for the rest of the running turn, matching the old getSettings() read.
import type { PermissionMode } from '../shared/types'
import { getConversationMeta } from './db'
import { getSettings } from './settings'

export function resolveConversationMode(conversationId: string): PermissionMode {
  return getConversationMeta(conversationId)?.permissionMode ?? getSettings().defaultPermissionMode
}

// A command prompts unless the conversation is in Auto mode.
export function commandNeedsApproval(mode: PermissionMode): boolean {
  return mode !== 'auto'
}
