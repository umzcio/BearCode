// Disk reader + cache for the .agents/ rules spine (design 3.1). Reads
// project `.agents/rules/*.md` and global `~/.bearcode/agents/rules/*.md`,
// merges them (project wins on filename collision), and resolves `@path`
// cross-references inside each rule body. Pure Node builtins only, no new
// deps. Malformed or missing content never throws (design 11 / Global
// Constraints): callers always get back an AgentsContent, at worst empty.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'
import { parseRuleFile } from './parseRule'
import type { AgentsContent, Rule } from './types'

const MAX_REF_BYTES = 64 * 1024
// Rule files themselves get the same cap as cross-refs: a rule is prompt
// text, so anything past 64KB is pathological, and routing the primary read
// through readFileCapped means an arbitrarily large .agents/rules/*.md can
// never be materialized in memory either (security review item 3).
const MAX_RULE_BYTES = MAX_REF_BYTES

// Bounded, stat-gated file read (security review item 1). Two guarantees:
// 1. Regular files ONLY: stats.isFile() is checked BEFORE any open. This is
//    what keeps a target like a FIFO (open blocks forever when no writer
//    exists), a device node (/dev/zero never ends), or any other non-regular
//    file from hanging or flooding the synchronous main process -- such
//    targets return null, which callers treat as unresolvable.
// 2. The read itself is bounded by a preallocated buffer of at most `cap`
//    bytes filled via fs.readSync on an fd -- never a whole-file
//    readFileSync -- so no unbounded read can occur regardless of what stat
//    reported (a file can grow between stat and read; the buffer bound holds
//    either way).
// Returns null on any error (missing, unreadable, non-regular): callers
// never throw on a bad target. `truncated` reports whether the file held
// more bytes than `cap`.
function readFileCapped(path: string, cap: number): { text: string; truncated: boolean } | null {
  let fd: number
  let size: number
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return null
    size = stats.size
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const toRead = Math.min(size, cap)
    const buf = Buffer.alloc(toRead)
    let offset = 0
    while (offset < toRead) {
      const n = readSync(fd, buf, offset, toRead - offset, offset)
      if (n === 0) break
      offset += n
    }
    return { text: buf.toString('utf8', 0, offset), truncated: size > cap }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

interface CacheEntry {
  mtimeMs: number
  rule: Rule // fully resolved (cross-refs already inlined)
}

// Cache of the FINAL (post cross-reference-resolution) Rule, keyed by
// absolute file path AND the projectPath the resolution ran against. A load
// re-stats every file it finds on disk and only re-parses + re-resolves
// files whose mtime changed since the last pass, or that are new --
// unchanged files return the exact same Rule object as the previous load (no
// fs watcher; a turn start and a menu open are the only consumers, both
// user-paced, per design 3.1). Including projectPath in the key matters for
// GLOBAL rules specifically: their file path alone does not vary between
// projects, but a global rule's body may contain a relative @path cross-ref,
// whose resolution depends on which project is currently open -- without
// this, switching projects could serve a global rule's cross-ref resolved
// against a stale, different project's workspace.
const cache = new Map<string, CacheEntry>()

function cacheKey(path: string, projectPath: string | null): string {
  return `${projectPath ?? ''}::${path}`
}

function globalRulesDir(): string {
  return join(homedir(), '.bearcode', 'agents', 'rules')
}

function listRuleFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f))
  } catch {
    // Unreadable directory (permissions, race with deletion, etc.) is treated
    // like a missing one -- never throw out of the loader.
    return []
  }
}

function ruleNameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf(sep) + 1)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

// Load + cache one rule file, resolving its cross-references. Returns null
// if the file can no longer be read (race: deleted between readdir and
// stat/read) -- the caller simply drops it from the result set. Malformed
// files (parseRuleFile sets `error`) are kept with the raw body, never
// cross-ref-resolved and never thrown.
function loadOneRule(
  path: string,
  name: string,
  source: 'project' | 'global',
  projectPath: string | null
): Rule | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }

  const key = cacheKey(path, projectPath)
  const cached = cache.get(key)
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.rule
  }

  // Bounded primary read: a rule file that is a non-regular file (would
  // block or never end) is dropped like an unreadable one, and an oversized
  // one is truncated at the cap with a warning instead of being read whole.
  const read = readFileCapped(path, MAX_RULE_BYTES)
  if (!read) return null
  const fileWarnings: string[] = read.truncated
    ? [`Rule file exceeds ${MAX_RULE_BYTES / 1024}KB and was truncated`]
    : []

  const parsed = parseRuleFile(name, read.text, source)
  let rule: Rule = parsed
  if (!parsed.error) {
    // Seed the cycle-detection chain with this file's own absolute path, so
    // a ref chain that loops back to the rule file itself is caught.
    const { body, warnings } = resolveRuleRefs(parsed.body, projectPath, new Set([path]))
    const allWarnings = [...fileWarnings, ...warnings]
    if (body !== parsed.body || allWarnings.length > 0) {
      rule = { ...parsed, body, warnings: allWarnings.length > 0 ? allWarnings : undefined }
    }
  } else if (fileWarnings.length > 0) {
    rule = { ...parsed, warnings: fileWarnings }
  }

  cache.set(key, { mtimeMs, rule })
  return rule
}

// Read `<projectPath>/.agents/rules/*.md` (project) and
// `~/.bearcode/agents/rules/*.md` (global), merge them (project wins on a
// filename collision), and return the live rule set. Missing directories are
// treated as empty, never an error.
export function loadAgentsContent(projectPath: string | null): AgentsContent {
  const projectDir = projectPath ? join(projectPath, '.agents', 'rules') : null
  const projectFiles = projectDir ? listRuleFiles(projectDir) : []
  const globalFiles = listRuleFiles(globalRulesDir())

  const byName = new Map<string, Rule>()

  for (const path of globalFiles) {
    const name = ruleNameFromPath(path)
    const rule = loadOneRule(path, name, 'global', projectPath)
    if (rule) byName.set(name, rule)
  }
  // Project rules load second and overwrite same-named global entries, so
  // project always wins on collision.
  for (const path of projectFiles) {
    const name = ruleNameFromPath(path)
    const rule = loadOneRule(path, name, 'project', projectPath)
    if (rule) byName.set(name, rule)
  }

  return { rules: Array.from(byName.values()) }
}

// Resolve `@<path>` cross-reference tokens in a rule body (design 2 / 3.1).
//
// Token grammar: an `@` immediately followed by a filesystem path, ending at
// the next whitespace character or end of string (DOCUMENTED CHOICE -- the
// design's Antigravity-replication note describes the resolution order but
// not an exact token grammar for rule-body refs).
//
// Resolution order (design 2, security-authoritative in design 10):
//   1. Absolute path (starts with "/"): read directly, READ-ONLY, allowed to
//      point anywhere on disk (documented Antigravity-parity behavior).
//   2. Otherwise: resolve relative to the workspace root (projectPath) and
//      verify containment with a path-separator boundary check (see
//      isInsideWorkspace below) before reading -- this is the same
//      resolve-then-verify-prefix idiom as fsBackend.ts's jailPath, reused
//      here per the design's explicit instruction. A plain resolve+prefix
//      check (no realpath/symlink resolution) is sufficient because this is
//      read-only TEXT INCLUSION into a prompt, never executed and never
//      written back (design 10).
//
// Unresolvable refs (file missing, escapes the workspace, or a repeat within
// the current resolution chain -- see cycle detection below) are left as the
// literal `@<path>` token in the output and recorded as a warning; this
// function never throws.
//
// Work bounds (security review item 2). Three cooperating guards:
// - `inlinedChain` (per recursion PATH): the set of absolute paths inlined
//   along the current chain, seeded by the caller with the rule file's own
//   path, so a cycle (A -> B -> A) is detected and the repeat left literal
//   with a cycle warning instead of recursing forever.
// - `visited` (GLOBAL per top-level resolution): every file ever inlined
//   anywhere during one rule's resolution. Without this, branching ref trees
//   do k^depth work (a diamond A -> {B, C} -> D inlines D twice; wider trees
//   explode exponentially) even though no single chain cycles. A file
//   already inlined once anywhere is not inlined again: literal token +
//   warning, making total work linear in DISTINCT files.
// - `inclusions` counter with a hard cap (MAX_INCLUSIONS) and MAX_CHAIN_DEPTH
//   as belt-and-braces ceilings on total inclusions and recursion depth
//   respectively; refs past either bound stay literal with a warning.
const MAX_CHAIN_DEPTH = 40
const MAX_INCLUSIONS = 64

interface ResolveState {
  visited: Set<string>
  inclusions: number
}

export function resolveRuleRefs(
  body: string,
  projectPath: string | null,
  inlinedChain: Set<string> = new Set()
): { body: string; warnings: string[] } {
  const state: ResolveState = { visited: new Set(), inclusions: 0 }
  return resolveRefsInner(body, projectPath, inlinedChain, 0, state)
}

function resolveRefsInner(
  body: string,
  projectPath: string | null,
  inlinedChain: Set<string>,
  depth: number,
  state: ResolveState
): { body: string; warnings: string[] } {
  const warnings: string[] = []
  const tokenPattern = /@(\S+)/g
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(body)) !== null) {
    const token = match[0]
    const refPath = match[1]
    result += body.slice(lastIndex, match.index)
    lastIndex = match.index + token.length

    if (depth >= MAX_CHAIN_DEPTH) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath} (max reference depth exceeded)`)
      continue
    }

    if (state.inclusions >= MAX_INCLUSIONS) {
      result += token
      warnings.push(
        `Could not resolve rule reference: @${refPath} (inclusion limit of ${MAX_INCLUSIONS} reached)`
      )
      continue
    }

    const resolution = resolveRefPath(refPath, projectPath)
    if (!resolution) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath}`)
      continue
    }

    if (inlinedChain.has(resolution)) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath} (reference cycle detected)`)
      continue
    }

    if (state.visited.has(resolution)) {
      result += token
      warnings.push(
        `Could not resolve rule reference: @${refPath} (already included once in this rule)`
      )
      continue
    }

    // Bounded, non-regular-rejecting read: a missing file, a directory, a
    // FIFO, a device node, or any read error all degrade to the literal
    // token + warning, and at most MAX_REF_BYTES are ever read.
    const read = readFileCapped(resolution, MAX_REF_BYTES)
    if (!read) {
      result += token
      warnings.push(`Could not resolve rule reference: @${refPath}`)
      continue
    }

    state.visited.add(resolution)
    state.inclusions += 1

    // Recurse into the referenced file's own content so nested refs resolve
    // too, extending the chain with this file's resolved path so a cycle
    // back to it (or to any ancestor in the chain) is caught.
    const nestedChain = new Set(inlinedChain)
    nestedChain.add(resolution)
    const nested = resolveRefsInner(read.text, projectPath, nestedChain, depth + 1, state)
    warnings.push(...nested.warnings)

    // Read-only text inclusion, never executed: fenced with a header line
    // naming the resolved path so the inclusion is clearly attributed and
    // machine-testable.
    result += `\n--- begin @${refPath} (${resolution}) ---\n${nested.body}\n--- end @${refPath} ---\n`
  }
  result += body.slice(lastIndex)

  return { body: result, warnings }
}

// Resolve one `@<path>` token to an absolute filesystem path, or null if it
// cannot be resolved (missing projectPath for a relative ref, or a relative
// ref that escapes the workspace). Existence is NOT checked here -- callers
// attempt the read and treat a failure the same as an unresolvable path.
function resolveRefPath(refPath: string, projectPath: string | null): string | null {
  if (isAbsolute(refPath)) {
    // Absolute refs may point outside the workspace: documented, intentional
    // Antigravity-parity behavior (design 10), still read-only and capped.
    return refPath
  }
  if (!projectPath) return null
  const root = resolve(projectPath)
  const candidate = resolve(root, refPath)
  return isInsideWorkspace(root, candidate) ? candidate : null
}

// Boundary-safe containment check (mirrors fsBackend.ts's jailPath idiom,
// reused here per the design's instruction): compares against `root + sep`
// rather than a naive startsWith(root), so a sibling directory that merely
// shares root as a string prefix (e.g. root "/work/proj" and candidate
// "/work/proj-evil/secret") is correctly rejected instead of misclassified
// as inside the workspace.
function isInsideWorkspace(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}
