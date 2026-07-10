import type {
  CommandDecision,
  EditDecision,
  PermissionMode,
  PermissionRule,
  TerminalAutoExec
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
//
// Both sides are folded to lowercase: on case-insensitive filesystems (macOS
// APFS, Windows NTFS) a FIRST write to '.ENV' creates the same file a deny on
// '.env' meant to protect, and realpath cannot canonicalize the casing of a
// file that does not exist yet. Deny rules prefer over-matching, so we accept
// the (rare) over-block on case-sensitive filesystems.
function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
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

// Design §3/§4.2 (edits), precedence:
//   1. any matching deny rule           -> block
//   2. mode === 'plan'                   -> block (TRUE read-only; outranks ask)
//   3. any matching ask rule             -> prompt
//   4. mode fallback: ask -> prompt (stricter than accept-edits),
//      accept-edits/auto -> apply
// There is no allow tier for edits -- an 'allow' edit rule is inert and ignored.
// Bypass never reaches here: the *ForConversation entry point (index.ts)
// short-circuits first.
export function evaluateEdit(
  relPath: string,
  mode: PermissionMode,
  rules: PermissionRule[]
): EditDecision {
  const matching = rules.filter((r) => r.action === 'edit' && matchesEditPath(r.match, relPath))
  if (matching.some((r) => r.effect === 'deny')) return 'block'
  if (mode === 'plan') return 'block'
  if (matching.some((r) => r.effect === 'ask')) return 'prompt'
  return mode === 'ask' ? 'prompt' : 'apply'
}

// Security-critical evaluation order (design §4.2), effect-priority:
//   1. any matching deny (builtin or user) -> block   (deny always wins)
//   1b. else if mode === 'plan' -> block (TRUE read-only; outranks allow/ask)
//   2. else any matching allow             -> run
//   3. else any matching ask               -> prompt
//   4.  else the mode decides: auto -> run (unless terminalAutoExec tightens
//       it), otherwise -> prompt
// Because deny is checked first, a user allow can never override a builtin deny
// (§4.4). Pure over its inputs -- rules are passed in (BUILTIN_RULES + user
// rules for the scope), so this is unit-testable with no DB/Electron.
//
// F8 terminalAutoExec (only tightens): it applies ONLY to the auto-mode
// fallback. 'require-review' downgrades that fallback run→prompt so an
// auto-mode conversation reviews commands while still auto-applying edits. It
// NEVER changes deny, plan-block, an explicit allow rule, or a non-auto mode --
// it can only add a prompt, never remove one. Default 'auto' keeps today's
// behavior (and every pre-F8 caller/test) identical.
export function evaluateCommand(
  command: string,
  mode: PermissionMode,
  rules: PermissionRule[],
  terminalAutoExec: TerminalAutoExec = 'auto'
): CommandDecision {
  const matching = rules.filter((r) => r.action === 'command' && matchesCommand(r.match, command))
  if (matching.some((r) => r.effect === 'deny')) return 'block'
  // Plan mode is TRUE read-only: block outranks allow/ask (design §4.2), second
  // only to deny. Bypass never reaches here (index.ts short-circuits first).
  if (mode === 'plan') return 'block'
  if (matching.some((r) => r.effect === 'allow')) return 'run'
  if (matching.some((r) => r.effect === 'ask')) return 'prompt'
  return mode === 'auto' && terminalAutoExec === 'auto' ? 'run' : 'prompt'
}

// MCP tool matcher. Designed grammar (Claude Code, design §4): the SERVER
// portion is always a literal and must equal `server` exactly -- a glob may
// appear ONLY after the literal `server.` prefix, and only as a trailing `*`.
// Accepted forms:
//   `github`            -> every tool on exactly `github`
//   `github.*`          -> every tool on exactly `github`
//   `github.get_issue`  -> that exact tool
//   `github.get_*`      -> tools whose name starts with `get_`
// This deliberately rejects the over-broad shapes the previous startsWith/
// endsWith idiom allowed: `git*` (would auto-run any `git…`-named server),
// bare `*` (everything everywhere), and `*.get_issue` (crosses servers) --
// allow over-matching crosses trust boundaries, so the grammar is anchored.
// The server boundary is the FIRST '.', matching the `server.tool` convention.
export function matchesMcpTool(pattern: string, server: string, tool: string): boolean {
  const dot = pattern.indexOf('.')
  if (dot === -1) return pattern === server // bare server -> any tool on it
  const serverPart = pattern.slice(0, dot)
  const toolPart = pattern.slice(dot + 1)
  if (serverPart !== server) return false // server portion is always literal
  if (toolPart === '*') return true // `server.*` -> any tool
  const star = toolPart.indexOf('*')
  if (star === -1) return toolPart === tool // exact tool
  if (star !== toolPart.length - 1) return false // glob allowed only at the end
  return tool.startsWith(toolPart.slice(0, star))
}

// Precedence for the 'mcp' permission action (design, Task 4):
//   1. any matching deny  -> block   (deny always wins, security floor)
//   2. mode === 'plan' && !serverReadOnly -> block (MCP DIVERGES from
//      command/edit here: a read-only server's tools may proceed to the
//      normal gate below instead of being hard-blocked)
//   3. any matching allow -> run
//   4. any matching ask   -> prompt
//   5. default            -> prompt (no auto-run fallback for MCP, unlike
//      command's auto+terminalAutoExec)
// Deny is checked BEFORE the plan/readOnly carve-out, so a read-only server's
// allowance can never override a deny -- the security floor holds even in the
// one mode where MCP behaves differently from command/edit.
export function evaluateMcp(
  server: string,
  tool: string,
  mode: PermissionMode,
  rules: PermissionRule[],
  serverReadOnly: boolean
): CommandDecision {
  const matching = rules.filter((r) => r.action === 'mcp' && matchesMcpTool(r.match, server, tool))
  if (matching.some((r) => r.effect === 'deny')) return 'block'
  if (mode === 'plan' && !serverReadOnly) return 'block'
  if (matching.some((r) => r.effect === 'allow')) return 'run'
  if (matching.some((r) => r.effect === 'ask')) return 'prompt'
  return 'prompt'
}
