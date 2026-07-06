import type { EditDecision, PermissionMode } from '../../shared/types'

// Maps an edit-permission decision to what generate_document should do. Returns
// null to proceed with the write, or a decline message. Deliberately has NO
// 'prompt'→interrupt path: creating a document never pauses the graph this
// phase (that would touch the interrupt/resume machinery); ask-mode declines
// with guidance to switch modes.
export function docGenGateMessage(decision: EditDecision, mode: PermissionMode): string | null {
  if (decision === 'apply') return null
  if (decision === 'block') {
    return mode === 'plan'
      ? 'Plan mode is read-only; submit a plan and wait for approval before creating files.'
      : 'Creating this file was blocked by a permission rule.'
  }
  // 'prompt' (ask mode / an ask rule): no interactive approval for generated docs yet.
  return 'I can create files when you are in Accept edits or Auto mode. Switch modes and ask again.'
}
