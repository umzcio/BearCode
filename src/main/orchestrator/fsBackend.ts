// Custom Deep Agents filesystem backend (BackendProtocolV2, verified shape:
// planning/replatform-api-notes.md section (a) / node_modules/deepagents/dist
// /agent-DURA4_mf.d.ts ~line 147). createDeepAgent() always injects its own
// built-in read_file/write_file/edit_file/ls/glob/grep tools (see graph.ts's
// header comment); this backend is what makes those built-ins operate on the
// REAL project directory instead of an in-memory/virtual filesystem, and
// route every write/edit through stageFile (src/main/diffs.ts) so
// changes land on disk write-through AND get recorded for the review pane,
// exactly like the deleted legacy engine did.
//
// jailPath below carries the jail logic inherited from the legacy engine's
// tool layer: every path is resolved against projectPath and verified to
// stay inside it after symlink resolution.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import { interrupt, isGraphInterrupt } from '@langchain/langgraph'
import { rgPath } from '@vscode/ripgrep'
import type {
  BackendProtocolV2,
  EditResult,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult
} from 'deepagents'
import type { FileDiffFile } from '../../shared/types'
import { stageFile } from '../diffs'
import { evaluateEditForConversation, resolveConversationMode } from '../permissions'
import { takeDeniedEditReplayPin } from './tools'

const execFileAsync = promisify(execFile)

// Resolve a model-supplied path against the workspace root. Handles both
// conventions Deep Agents' built-in tools may produce: plain relative paths
// (e.g. "index.html") and a virtual-root absolute style (e.g. "/index.html")
// some system prompts use to describe the workspace root as "/" -- if an
// absolute path doesn't already fall under the real root, it is treated as
// root-relative rather than a literal OS path.
// Resolve the longest EXISTING prefix of a path through realpath, re-
// appending the not-yet-existing suffix untouched -- so a path to a file
// that is about to be created still normalizes its existing ancestors
// (and any symlinks among them) to their canonical location.
function realpathExistingPrefix(p: string): string {
  let probe = p
  let suffix = ''
  for (;;) {
    try {
      probe = realpathSync(probe)
      break
    } catch {
      suffix = sep + basename(probe) + suffix
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return probe + suffix
}

export function jailPath(projectPath: string, p: string | undefined): string {
  const root = realpathSync(projectPath)
  let raw: string
  if (!p || p === '.' || p === '/') {
    raw = root
  } else if (isAbsolute(p)) {
    if (p === root || p.startsWith(root + sep)) {
      // Literal OS path already textually under the (realpath'd) root. Keep
      // the RAW string so the containment check at the bottom still resolves
      // any symlinks the path crosses INSIDE the workspace and throws on a
      // real escape (e.g. <root>/link-to-outside/secret) exactly as before.
      raw = p
    } else {
      // SECURITY (jail) -- smoke finding F1 (.superpowers/sdd/task-5-report.md):
      // `root` above is realpath'd, so a purely TEXTUAL prefix test here
      // misclassifies an absolute path that reaches the workspace THROUGH a
      // symlink. macOS classic: workspace opened as /tmp/proj while /tmp ->
      // /private/tmp -- the agent's '/tmp/proj/guarded/x' does not start
      // with '/private/tmp/proj', so it used to fall into the virtual-root
      // branch and resolve to the nested phantom '<root>/tmp/proj/guarded/x'.
      // Two observed consequences: the write landed at that wrong nested
      // path, and relForGate yielded 'tmp/proj/guarded/x', silently dodging
      // edit rules like 'guarded/**'. Normalizing the INCOMING path first
      // (longest existing prefix through realpath, not-yet-created suffix
      // re-appended -- the same idiom the final containment check uses) maps
      // it to '/private/tmp/proj/guarded/x', which the prefix test then
      // accepts as a genuine workspace path. Anything that normalizes to a
      // location still outside the root keeps the legacy virtual-root
      // fallback (treated as root-relative, never an escape). This branch
      // can only PROMOTE a path into the inside-the-jail interpretation; the
      // authoritative containment check at the bottom still runs on the
      // result, so no escape path is widened.
      const normalized = realpathExistingPrefix(p)
      raw =
        normalized === root || normalized.startsWith(root + sep)
          ? normalized
          : resolve(root, p.slice(1))
    }
  } else {
    raw = resolve(root, p)
  }
  const real = realpathExistingPrefix(raw)
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`Path is outside the workspace: ${p}`)
  }
  return real
}

async function rg(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(rgPath, args, {
      cwd,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024
    })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    if (e.code === 1) return { stdout: e.stdout ?? '', code: 1 } // no matches
    throw err
  }
}

// Diff-backed filesystem backend for one run. One instance per turn (created
// fresh in graph.ts) so `stagedFiles` only ever holds this turn's writes.
export class DiffFsBackend implements BackendProtocolV2 {
  readonly stagedFiles: FileDiffFile[] = []

  constructor(
    private readonly conversationId: string,
    private readonly projectPath: string,
    private readonly diffGroupId: string
  ) {}

  async ls(path: string): Promise<LsResult> {
    try {
      const dir = jailPath(this.projectPath, path)
      const entries = readdirSync(dir, { withFileTypes: true })
      const files = entries
        .filter((e) => e.name !== '.git')
        .map((e) => ({ path: e.isDirectory() ? `${e.name}/` : e.name, is_dir: e.isDirectory() }))
        .sort((a, b) => a.path.localeCompare(b.path))
      return { files }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    try {
      const abs = jailPath(this.projectPath, filePath)
      const all = readFileSync(abs, 'utf8').split('\n')
      const slice = all.slice(offset, offset + limit)
      const notice =
        offset + slice.length < all.length
          ? `\n… truncated: showing lines ${offset + 1}-${offset + slice.length} of ${all.length}`
          : ''
      return { content: slice.join('\n') + notice, mimeType: 'text/plain' }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const abs = jailPath(this.projectPath, filePath)
      const stat = statSync(abs)
      const content = readFileSync(abs, 'utf8')
      return {
        data: {
          content,
          mimeType: 'text/plain',
          created_at: stat.birthtime.toISOString(),
          modified_at: stat.mtime.toISOString()
        }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    try {
      const dir = jailPath(this.projectPath, path ?? undefined)
      const args = ['-n', '--no-heading', '-F', '--max-columns', '250', '-e', pattern]
      if (glob) args.push('-g', glob)
      args.push('.')
      const { stdout, code } = await rg(args, dir)
      if (code === 1) return { matches: [] }
      const matches = stdout
        .split('\n')
        .filter(Boolean)
        .slice(0, 200)
        .map((line) => {
          const m = /^(.*?):(\d+):(.*)$/.exec(line)
          return m
            ? { path: m[1], line: Number(m[2]), text: m[3] }
            : { path: line, line: 0, text: '' }
        })
      return { matches }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    try {
      const dir = jailPath(this.projectPath, path)
      const { stdout } = await rg(
        ['--files', '--hidden', '-g', '!.git', '-g', pattern, '--sort', 'path'],
        dir
      )
      const files = stdout
        .split('\n')
        .filter(Boolean)
        .slice(0, 500)
        .map((p) => ({ path: p, is_dir: false }))
      return { files }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const abs = jailPath(this.projectPath, filePath)
      const before = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
      const staged = stageFile(this.diffGroupId, this.conversationId, abs, before, content)
      this.stagedFiles.push(staged)
      return { path: filePath, filesUpdate: null }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    try {
      const abs = jailPath(this.projectPath, filePath)
      if (!existsSync(abs)) return { error: `File not found: ${filePath}` }
      const before = readFileSync(abs, 'utf8')
      const count = before.split(oldString).length - 1
      if (count === 0) return { error: `old string not found in ${filePath}` }
      if (!replaceAll && count > 1) {
        return { error: `old string appears ${count} times in ${filePath}; it must be unique` }
      }
      const after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString)
      const staged = stageFile(this.diffGroupId, this.conversationId, abs, before, after)
      this.stagedFiles.push(staged)
      return { path: filePath, occurrences: count, filesUpdate: null }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// Workspace-relative path (forward slashes) for the edit-rules engine. Always
// computed from jailPath's RESOLVED absolute path, never the raw agent-supplied
// string, so a traversal-laden 'a/../.env' evaluates as '.env' and can not
// dodge a deny rule (Task 1 review carry-forward).
export function relForGate(projectPath: string, abs: string): string {
  return relative(projectPath, abs).split(sep).join('/')
}

// Per-tool-invocation wrapper created by the backend factory (graph.ts).
// Deep Agents resolves the backend once per builtin-tool call and the
// runtime it hands the factory carries the provider tool-call id, which the
// published factory type does not yet declare (hence the cast at the call
// site). Everything except write/edit delegates straight to the one shared
// DiffFsBackend so staged-file accumulation and the review pane are
// untouched. The gate MUST run before shared.write/edit because stageFile
// inside them is the disk side effect; interrupt() throws on first
// execution and returns the resume value on the replay, so an unapproved
// write never reaches disk (probe: planning/probe-bb3-edit-interrupt.mjs).
export class GatedDiffFsBackend implements BackendProtocolV2 {
  constructor(
    private readonly shared: DiffFsBackend,
    private readonly toolCallId: string | undefined,
    private readonly conversationId: string,
    private readonly projectPath: string
  ) {}

  // Returns {error} when the write must not happen, null when it may proceed
  // ('apply' decision or an approved interrupt). jailPath runs in its own
  // try/catch so its outside-workspace throw becomes {error} exactly like the
  // shared methods classify it; the rules evaluation and interrupt() run
  // OUTSIDE any try so a GraphInterrupt always propagates as the
  // pending-approval pause instead of being swallowed into {error}.
  private gate(filePath: string, tool: 'write_file' | 'edit_file'): { error: string } | null {
    // BEFORE anything else -- jail resolution included -- honor a recorded
    // denial from the approval batch (tools.ts deniedReplayPins): on the
    // keyed-resume replay this method re-runs from the top, and if the rules
    // evaluation below returned 'apply' now, the interrupt() would be skipped
    // and the denied write would land. Adjudication (Task 4 carry-forward):
    // evaluateEdit has no allow tier today, so an ADDED edit rule can only
    // tighten a 'prompt' (deny -> 'block', which still does not execute), and
    // no renderer UX removes rules or saves edit rules from an approval card
    // in Bb3 -- but the add-rule IPC (ipc.ts bearcode:permissions:add-rule ->
    // addUserRule) already accepts action:'edit' rules unvalidated (Task 1
    // widened AddRuleInput.action to the full PermissionAction union), so the
    // mid-pause flip window is treated as real and pinned at the execution
    // layer, exactly like run_command. The pin match uses the RAW agent
    // string (pre-jail): the pin was stored from the same raw string.
    if (takeDeniedEditReplayPin(this.conversationId, this.toolCallId, filePath)) {
      return { error: 'User denied this edit.' }
    }
    let rel: string
    try {
      const abs = jailPath(this.projectPath, filePath)
      // Relative to the same realpath'd root jailPath resolved against, so a
      // symlinked projectPath (e.g. /tmp on macOS) still yields 'src/a.ts'.
      rel = relForGate(realpathSync(this.projectPath), abs)
    } catch (err) {
      // Defense in depth: nothing in this try raises a GraphInterrupt today,
      // but one must never be classified as a plain {error}.
      if (isGraphInterrupt(err)) throw err
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const decision = evaluateEditForConversation(rel, this.conversationId, this.projectPath)
    if (decision === 'block') {
      // 'block' is either a deny rule OR plan-mode read-only. Re-read the mode
      // live so the agent learns WHY the edit was blocked (mode-picker design §5).
      return resolveConversationMode(this.conversationId) === 'plan'
        ? {
            error:
              'Plan mode is read-only; submit a plan and wait for approval before editing or running commands.'
          }
        : { error: `Editing ${filePath} is blocked by a permission rule.` }
    }
    if (decision === 'prompt') {
      // Resume value is a truthy object, never a bare boolean -- same
      // EmptyInputError footgun documented on run_command (tools.ts). The
      // payload contract ({kind, tool, path, resolvedPath, toolCallId}) is
      // what Task 4's pairing and the renderer's approval card consume:
      // 'path' stays the RAW agent string (the fallback pairing matches it
      // against the streamed tool-call args) while 'resolvedPath' is the
      // jail-resolved workspace-relative path the UI must display -- a card
      // showing 'safe/../.env' while the write lands on '.env' would mislead
      // the user into approving.
      const approval = interrupt({
        kind: 'edit_file',
        tool,
        path: filePath,
        resolvedPath: rel,
        toolCallId: this.toolCallId
      }) as { approved: boolean }
      if (!approval.approved) return { error: 'User denied this edit.' }
    }
    return null
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const denied = this.gate(filePath, 'write_file')
    if (denied) return denied
    return this.shared.write(filePath, content)
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    const denied = this.gate(filePath, 'edit_file')
    if (denied) return denied
    return this.shared.edit(filePath, oldString, newString, replaceAll)
  }

  // Every remaining BackendProtocolV2 method DiffFsBackend implements,
  // delegated 1:1 (read-side, no gate). uploadFiles/downloadFiles are
  // optional in the protocol and DiffFsBackend does not implement them.
  ls(path: string): Promise<LsResult> {
    return this.shared.ls(path)
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.shared.read(filePath, offset, limit)
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.shared.readRaw(filePath)
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    return this.shared.grep(pattern, path, glob)
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.shared.glob(pattern, path)
  }
}
