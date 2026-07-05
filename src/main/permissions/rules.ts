import type {
  CommandDecision,
  EditDecision,
  PermissionMode,
  PermissionRule
} from '../../shared/types'
import { BUILTIN_RULES } from './builtins'

export { BUILTIN_RULES }

// Collapse runs of whitespace to a single space (and trim) so extra spacing can
// never dodge a rule -- e.g. 'rm  -rf  /' must still hit the 'rm -rf /' deny.
// Normalization is match-only; the command still executes exactly as issued.
// (This does not defend against flag reordering, case, or a `sudo` prefix -- the
// built-in denies are a conservative backstop, not a shell parser; see the
// permission-modes design note on built-ins.)
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

// A pattern is an exact string, or contains a single '*' wildcard: everything
// before the '*' must be a prefix and everything after it a suffix of the
// (normalized) command. Users only author exact or trailing-'*' patterns;
// built-ins may put the '*' in the middle (e.g. 'curl * | sh').
export function matchesCommand(pattern: string, command: string): boolean {
  const cmd = normalize(command)
  const pat = normalize(pattern)
  const star = pat.indexOf('*')
  if (star === -1) return cmd === pat
  const prefix = pat.slice(0, star)
  const suffix = pat.slice(star + 1)
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

// Edit patterns are workspace-relative path globs: '*' matches within one
// path segment, '**' matches one or more whole segments. No regex, no
// brace/negation syntax -- the grammar stays as small as the builtins need
// (see matchesCommand's precedent). Matching is on the normalized relative
// path (forward slashes, no leading './'); outside-workspace paths never
// reach this function because jailPath blocks them structurally.
function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

// A single path segment (no '/') matches literally except for '*', which
// stands in for zero or more non-'/' characters.
function matchesSegment(patSeg: string, pathSeg: string): boolean {
  const star = patSeg.indexOf('*')
  if (star === -1) return pathSeg === patSeg
  const prefix = patSeg.slice(0, star)
  const suffix = patSeg.slice(star + 1)
  return (
    pathSeg.startsWith(prefix) &&
    pathSeg.endsWith(suffix) &&
    pathSeg.length >= prefix.length + suffix.length
  )
}

// Recursive segment matcher: '**' consumes one or more whole path segments
// (never zero, so '.git/**' does not match '.git' itself), everything else
// matches exactly one segment via matchesSegment.
function matchesSegments(patSegs: string[], pathSegs: string[]): boolean {
  if (patSegs.length === 0) return pathSegs.length === 0
  const [head, ...restPat] = patSegs
  if (head === '**') {
    for (let consumed = 1; consumed <= pathSegs.length; consumed++) {
      if (matchesSegments(restPat, pathSegs.slice(consumed))) return true
    }
    return false
  }
  if (pathSegs.length === 0) return false
  return matchesSegment(head, pathSegs[0]) && matchesSegments(restPat, pathSegs.slice(1))
}

export function matchesEditPath(pattern: string, relPath: string): boolean {
  const patSegs = normalizeRelPath(pattern).split('/')
  const pathSegs = normalizeRelPath(relPath).split('/')
  return matchesSegments(patSegs, pathSegs)
}

// Design 4.2 (edits): deny -> block, ask -> prompt, else apply. There is no
// allow tier -- the default is already apply, so an 'allow' edit rule is
// inert and ignored. Mode never participates (unlike commands).
export function evaluateEdit(relPath: string, rules: PermissionRule[]): EditDecision {
  const matching = rules.filter((r) => r.action === 'edit' && matchesEditPath(r.match, relPath))
  if (matching.some((r) => r.effect === 'deny')) return 'block'
  if (matching.some((r) => r.effect === 'ask')) return 'prompt'
  return 'apply'
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
