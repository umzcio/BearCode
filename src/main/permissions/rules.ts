import type { CommandDecision, PermissionMode, PermissionRule } from '../../shared/types'
import { BUILTIN_RULES } from './builtins'

export { BUILTIN_RULES }

// A pattern is an exact string, or contains a single '*' wildcard: everything
// before the '*' must be a prefix and everything after it a suffix of the
// (trimmed) command. Users only author exact or trailing-'*' patterns; built-ins
// may put the '*' in the middle (e.g. 'curl * | sh').
export function matchesCommand(pattern: string, command: string): boolean {
  const cmd = command.trim()
  const star = pattern.indexOf('*')
  if (star === -1) return cmd === pattern
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (suffix === '') {
    // Trailing '*' (the user-authored form): prefix match, and a bare command
    // equal to the trimmed prefix also matches, so 'git *' covers BOTH 'git' and
    // 'git push origin main'.
    return cmd.startsWith(prefix) || cmd === prefix.trimEnd()
  }
  // '*' embedded in the middle (built-ins like 'curl * | sh'): prefix + suffix
  // with no overlap.
  return (
    cmd.startsWith(prefix) && cmd.endsWith(suffix) && cmd.length >= prefix.length + suffix.length
  )
}

// Security-critical evaluation order (design §4.2), effect-priority:
//   1. any matching deny (builtin or user) -> block   (deny always wins)
//   2. else any matching allow             -> run
//   3. else any matching ask               -> prompt
//   4. else the mode decides: auto -> run, otherwise -> prompt
// Because deny is checked first, a user allow can never override a builtin deny
// (§4.4). Pure over its inputs -- rules are passed in (BUILTIN_RULES + user
// rules for the scope), so this is unit-testable with no DB/Electron.
export function evaluateCommand(
  command: string,
  mode: PermissionMode,
  rules: PermissionRule[]
): CommandDecision {
  const matching = rules.filter((r) => r.action === 'command' && matchesCommand(r.match, command))
  if (matching.some((r) => r.effect === 'deny')) return 'block'
  if (matching.some((r) => r.effect === 'allow')) return 'run'
  if (matching.some((r) => r.effect === 'ask')) return 'prompt'
  return mode === 'auto' ? 'run' : 'prompt'
}
