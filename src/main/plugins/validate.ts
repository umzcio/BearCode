// Wire-boundary validators for the bearcode:plugins:* IPC handlers, mirroring
// the assertValid*/asProjectPath idiom used throughout ipc.ts: reject
// anything looser than the expected shape BEFORE it reaches the plugins
// module, which otherwise trusts scope/name as already-validated.
import { COMMAND_NAME_PATTERN } from '../../shared/types'

export function validateScope(x: unknown): 'global' | 'project' {
  if (x !== 'global' && x !== 'project') throw new Error(`Invalid plugin scope: ${String(x)}`)
  return x
}

export function validateName(x: unknown): string {
  if (typeof x !== 'string' || !COMMAND_NAME_PATTERN.test(x)) {
    throw new Error(`Invalid plugin name: ${String(x)}`)
  }
  return x
}
