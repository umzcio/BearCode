// Wire-boundary validators for the bearcode:hooks:* IPC handlers, mirroring
// plugins/validate.ts's assertValid*/asProjectPath idiom: reject anything
// looser than the expected shape BEFORE it reaches the hooks modules, which
// otherwise trust event/name as already-validated.
import { COMMAND_NAME_PATTERN, type HookEvent } from '../../shared/types'

export function validateHookEvent(x: unknown): HookEvent {
  if (x !== 'PreToolUse' && x !== 'PostToolUse') {
    throw new Error(`Invalid hook event: ${String(x)}`)
  }
  return x
}

export function validateHookName(x: unknown): string {
  if (typeof x !== 'string' || !COMMAND_NAME_PATTERN.test(x)) {
    throw new Error(`Invalid hook name: ${String(x)}`)
  }
  return x
}
