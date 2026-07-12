import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// fsBackend.ts imports ../permissions and ../diffs, both of which reach
// ../db (electron/sqlite at call time); mock them so importing the module
// under test never opens a real database, and so the gate's rules-engine
// calls are observable (same idiom as tools.test.ts).
vi.mock('../permissions', () => ({
  evaluateEditForConversation: vi.fn(() => 'apply'),
  // fsBackend.ts now pulls the denied-replay pins in from ./tools, whose
  // module scope imports this from ../permissions too.
  evaluateCommandForConversation: vi.fn(() => 'run'),
  resolveConversationMode: vi.fn(() => 'accept-edits')
}))
vi.mock('../diffs', () => ({
  stageFile: vi.fn()
}))
// F8: the read gate reads fileAccessPolicy live from settings. Mock it so each
// test drives the policy; default 'deny' preserves the pre-F8 hard jail.
vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({ fileAccessPolicy: 'deny' }))
}))
// Keep the real @langchain/langgraph module (GraphInterrupt/isGraphInterrupt
// must be the genuine classes) and stub ONLY interrupt(), which would
// otherwise throw outside a running graph. This is not a mock LangGraph --
// just the same injection seam the runtime uses.
vi.mock('@langchain/langgraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph')>()
  return { ...actual, interrupt: vi.fn() }
})
// Task 8 review fix: GatedDiffFsBackend now runs the built-in fs tools
// (ls/read_file/write_file/edit_file/glob/grep) through the SAME
// PreToolUse/PostToolUse hooks layer wrap.ts uses for custom tools. Mocked
// exactly like hooks/wrap.test.ts mocks it -- this test file exercises only
// the gating/decision-routing logic, not real hook spawning (covered by
// runner.test.ts), and avoids pulling the real runner.ts's transitive
// sandbox/policy.ts -> 'electron' import into a plain node vitest run.
const mockRunPreToolUse = vi.fn()
const mockRunPostToolUse = vi.fn()
vi.mock('../hooks/runner', () => ({
  runPreToolUse: (...args: unknown[]) => mockRunPreToolUse(...args),
  runPostToolUse: (...args: unknown[]) => mockRunPostToolUse(...args)
}))

import { GraphInterrupt, interrupt, isGraphInterrupt } from '@langchain/langgraph'
import { stageFile } from '../diffs'
import { evaluateEditForConversation, resolveConversationMode } from '../permissions'
import { getSettings } from '../settings'
import { DiffFsBackend, GatedDiffFsBackend, relForGate, jailPath } from './fsBackend'
import { clearDeniedReplayPins, pinDeniedReplays } from './tools'

describe('relForGate', () => {
  it('computes the workspace-relative path with forward slashes', () => {
    expect(relForGate('/tmp/proj', '/tmp/proj/src/a.ts')).toBe('src/a.ts')
    expect(relForGate('/tmp/proj', '/tmp/proj/.env')).toBe('.env')
  })

  it('evaluates a traversal-laden agent path by its RESOLVED location', () => {
    // Carry-forward from the Task 1 review: 'a/../.env' must gate as '.env',
    // never as the raw agent-supplied string.
    expect(relForGate('/tmp/proj', resolve('/tmp/proj', 'a/../.env'))).toBe('.env')
  })
})

// A fake shared backend: the gate tests only need to observe whether the
// disk-side-effect methods were reached and that reads delegate 1:1.
function fakeShared(): {
  write: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
  ls: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  readRaw: ReturnType<typeof vi.fn>
  grep: ReturnType<typeof vi.fn>
  glob: ReturnType<typeof vi.fn>
} {
  return {
    write: vi.fn(async () => ({ path: 'x', filesUpdate: null })),
    edit: vi.fn(async () => ({ path: 'x', occurrences: 1, filesUpdate: null })),
    ls: vi.fn(async () => ({ files: [] })),
    read: vi.fn(async () => ({ content: 'c', mimeType: 'text/plain' })),
    readRaw: vi.fn(async () => ({ data: {} })),
    grep: vi.fn(async () => ({ matches: [] })),
    glob: vi.fn(async () => ({ files: [] }))
  }
}

describe('GatedDiffFsBackend', () => {
  let projectPath: string
  let shared: ReturnType<typeof fakeShared>
  let gated: GatedDiffFsBackend

  beforeEach(() => {
    clearDeniedReplayPins('convo')
    vi.mocked(evaluateEditForConversation).mockClear()
    vi.mocked(evaluateEditForConversation).mockReturnValue('apply')
    vi.mocked(resolveConversationMode).mockReturnValue('accept-edits')
    vi.mocked(interrupt).mockClear()
    projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'bearcode-gate-')))
    mkdirSync(join(projectPath, 'a'))
    writeFileSync(join(projectPath, 'a', 'b.txt'), 'hello')
    shared = fakeShared()
    gated = new GatedDiffFsBackend(shared as unknown as DiffFsBackend, 'tc1', 'convo', projectPath)
  })

  it("delegates write to the shared backend on an 'apply' decision", async () => {
    const result = await gated.write('a/b.txt', 'new')
    expect(shared.write).toHaveBeenCalledWith('a/b.txt', 'new')
    expect(result).toEqual({ path: 'x', filesUpdate: null })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('evaluates the jail-RESOLVED relative path, not the raw agent string', async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('block')
    await gated.write('a/../.env', 'SECRET=1')
    expect(evaluateEditForConversation).toHaveBeenCalledWith('.env', 'convo', projectPath)
  })

  it("returns {error} on a 'block' decision without touching the shared backend", async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('block')
    const result = await gated.write('.env', 'SECRET=1')
    expect(result).toEqual({ error: 'Editing .env is blocked by a permission rule.' })
    expect(shared.write).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('block in plan mode returns the read-only message, not the generic rule message', async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('block')
    vi.mocked(resolveConversationMode).mockReturnValue('plan')
    const result = await gated.write('.env', 'SECRET=1')
    expect(result).toEqual({
      error:
        'Plan mode is read-only; submit a plan and wait for approval before editing or running commands.'
    })
    expect(shared.write).not.toHaveBeenCalled()
  })

  it("interrupts on 'prompt' with the edit_file payload contract", async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await gated.write('a/b.txt', 'new')
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'edit_file',
      tool: 'write_file',
      path: 'a/b.txt',
      resolvedPath: 'a/b.txt',
      toolCallId: 'tc1'
    })
    expect(shared.write).toHaveBeenCalledWith('a/b.txt', 'new')
  })

  it('carries the RESOLVED relative path in the payload so the approval card is truthful', async () => {
    // A traversal-laden or aliased raw path must not be able to mislead the
    // user: 'path' stays the raw string (Task 4's fallback pairing matches it
    // against the tool call args) while 'resolvedPath' is what the UI shows.
    vi.mocked(evaluateEditForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await gated.write('a/../.env', 'SECRET=1')
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'edit_file',
      tool: 'write_file',
      path: 'a/../.env',
      resolvedPath: '.env',
      toolCallId: 'tc1'
    })
  })

  it('returns the denial {error} when the resume value is {approved: false}', async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ error: 'User denied this edit.' })
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('lets a GraphInterrupt from interrupt() PROPAGATE, never swallowed into {error}', async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockImplementation(() => {
      throw new GraphInterrupt()
    })
    let thrown: unknown
    try {
      await gated.write('a/b.txt', 'new')
    } catch (err) {
      thrown = err
    }
    expect(isGraphInterrupt(thrown)).toBe(true)
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('honors a denied-replay pin before the rules engine is even asked', async () => {
    // The Bb3 analog of run_command's execution-layer deny enforcement: the
    // add-rule IPC accepts action:'edit' rules today, so a rule change during
    // the collect window could otherwise flip the replayed evaluation.
    pinDeniedReplays('convo', [{ toolCallId: 'tc1', editPath: 'a/b.txt' }])
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ error: 'User denied this edit.' })
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('honors the pin for edit() too', async () => {
    pinDeniedReplays('convo', [{ toolCallId: 'tc1', editPath: 'a/b.txt' }])
    const result = await gated.edit('a/b.txt', 'hello', 'bye')
    expect(result).toEqual({ error: 'User denied this edit.' })
    expect(shared.edit).not.toHaveBeenCalled()
  })

  it('a consumed pin never denies a later identical write (take-once)', async () => {
    pinDeniedReplays('convo', [{ toolCallId: 'tc1', editPath: 'a/b.txt' }])
    await gated.write('a/b.txt', 'new')
    const result = await gated.write('a/b.txt', 'newer')
    expect(result).toEqual({ path: 'x', filesUpdate: null })
    expect(shared.write).toHaveBeenCalledTimes(1)
  })

  it('claims an id-less pin by the RAW agent path, before jail resolution', async () => {
    // The pin key and the replayed call both carry the raw string the model
    // sent, so the match happens on it verbatim (never the resolved path).
    pinDeniedReplays('convo', [{ editPath: 'a/../.env' }])
    const noId = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      undefined,
      'convo',
      projectPath
    )
    const result = await noId.write('a/../.env', 'SECRET=1')
    expect(result).toEqual({ error: 'User denied this edit.' })
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('classifies an outside-workspace path as {error} before any evaluation', async () => {
    const result = await gated.write('../escape.txt', 'x')
    expect(result).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('gates edit() the same way, with the edit_file tool name in the payload', async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await gated.edit('a/b.txt', 'hello', 'goodbye')
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'edit_file',
      tool: 'edit_file',
      path: 'a/b.txt',
      resolvedPath: 'a/b.txt',
      toolCallId: 'tc1'
    })
    expect(shared.edit).toHaveBeenCalledWith('a/b.txt', 'hello', 'goodbye', false)
  })

  it('returns {error} for a blocked edit() without touching the shared backend', async () => {
    vi.mocked(evaluateEditForConversation).mockReturnValue('block')
    const result = await gated.edit('.env', 'a', 'b', true)
    expect(result).toEqual({ error: 'Editing .env is blocked by a permission rule.' })
    expect(shared.edit).not.toHaveBeenCalled()
  })

  it('tolerates an undefined toolCallId (middleware-context factory invocations)', async () => {
    const noId = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      undefined,
      'convo',
      projectPath
    )
    vi.mocked(evaluateEditForConversation).mockReturnValue('prompt')
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await noId.write('a/b.txt', 'new')
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'edit_file',
      tool: 'write_file',
      path: 'a/b.txt',
      resolvedPath: 'a/b.txt',
      toolCallId: undefined
    })
  })

  it('delegates every non-write BackendProtocolV2 method 1:1 to the shared backend', async () => {
    // Inside-root reads delegate with allowOutsideRead=false (F8): the read gate
    // only relaxes OUTSIDE-root paths, so these stay identical to pre-F8.
    await gated.ls('a')
    expect(shared.ls).toHaveBeenCalledWith('a', false)
    await gated.read('a/b.txt', 3, 7)
    expect(shared.read).toHaveBeenCalledWith('a/b.txt', 3, 7, false)
    await gated.readRaw('a/b.txt')
    expect(shared.readRaw).toHaveBeenCalledWith('a/b.txt', false)
    await gated.grep('needle', 'a', '*.txt')
    expect(shared.grep).toHaveBeenCalledWith('needle', 'a', '*.txt', false)
    await gated.glob('**/*.txt', 'a')
    expect(shared.glob).toHaveBeenCalledWith('**/*.txt', 'a', false)
    // None of the read-side delegations consult the edit/write rules engine.
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
  })
})

// Regression pins for smoke finding F1 (.superpowers/sdd/task-5-report.md):
// when the workspace was opened via a symlinked path (macOS classic:
// /tmp/proj while /tmp -> /private/tmp) and the agent echoes back an
// ABSOLUTE path through that symlink, jailPath must resolve it to the real
// target and gate it by the TRUE workspace-relative path -- pre-fix it was
// misread as root-RELATIVE, producing a nested phantom write target and a
// relative path that silently dodged edit rules like 'guarded/**'.
describe('jailPath with a symlinked workspace root (smoke F1)', () => {
  let base: string
  let workspace: string
  let linkPath: string
  let shared: ReturnType<typeof fakeShared>

  beforeEach(() => {
    clearDeniedReplayPins('convo')
    vi.mocked(evaluateEditForConversation).mockClear()
    vi.mocked(evaluateEditForConversation).mockReturnValue('apply')
    vi.mocked(interrupt).mockClear()
    vi.mocked(stageFile).mockClear()
    // realpathSync'd base so the ONLY symlink in play is the one we create.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'bearcode-symlink-')))
    workspace = join(base, 'proj')
    mkdirSync(join(workspace, 'guarded'), { recursive: true })
    linkPath = join(base, 'wslink')
    symlinkSync(workspace, linkPath, 'dir')
    shared = fakeShared()
  })

  it('gates an absolute path supplied THROUGH the symlink by the true relative path', async () => {
    const gated = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc1',
      'convo',
      linkPath
    )
    await gated.write(join(linkPath, 'guarded', 'x.txt'), 'hi')
    // Pre-fix the evaluator saw a nested phantom ('…/wslink/guarded/x.txt'
    // relative shape), so a guarded/** ask rule never fired.
    expect(evaluateEditForConversation).toHaveBeenCalledWith('guarded/x.txt', 'convo', linkPath)
    expect(shared.write).toHaveBeenCalledWith(join(linkPath, 'guarded', 'x.txt'), 'hi')
  })

  it('stages the write at the REAL absolute target, not a nested phantom path', async () => {
    const backend = new DiffFsBackend('convo', linkPath, 'dg1')
    const result = await backend.write(join(linkPath, 'guarded', 'x.txt'), 'hi')
    expect(result).toEqual({ path: join(linkPath, 'guarded', 'x.txt'), filesUpdate: null })
    // Pre-fix this staged '<root>/<base>/wslink/guarded/x.txt' (wrong place).
    expect(stageFile).toHaveBeenCalledWith(
      'dg1',
      'convo',
      join(workspace, 'guarded', 'x.txt'),
      '',
      'hi'
    )
  })

  it('an absolute path via the REAL root still gates and delegates as before', async () => {
    const gated = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc1',
      'convo',
      workspace
    )
    await gated.write(join(workspace, 'guarded', 'x.txt'), 'hi')
    expect(evaluateEditForConversation).toHaveBeenCalledWith('guarded/x.txt', 'convo', workspace)
    expect(shared.write).toHaveBeenCalledWith(join(workspace, 'guarded', 'x.txt'), 'hi')
  })

  it('an escape attempt through a symlink inside the workspace still throws', async () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(workspace, 'out'), 'dir')
    const gated = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc1',
      'convo',
      workspace
    )
    const result = await gated.write(join(workspace, 'out', 'secret.txt'), 'x')
    expect(result).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('relative traversal behavior is unchanged under a symlinked root', async () => {
    const gated = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc1',
      'convo',
      linkPath
    )
    const escaped = await gated.write('../escape.txt', 'x')
    expect(escaped).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(shared.write).not.toHaveBeenCalled()
    const inside = await gated.write('guarded/../guarded/x.txt', 'hi')
    expect(inside).toEqual({ path: 'x', filesUpdate: null })
    expect(evaluateEditForConversation).toHaveBeenCalledWith('guarded/x.txt', 'convo', linkPath)
  })
})

describe('F8 fileAccessPolicy — outside-root READ relaxation (writes stay jailed)', () => {
  let projectPath: string
  let shared: ReturnType<typeof fakeShared>
  let gated: GatedDiffFsBackend

  beforeEach(() => {
    vi.mocked(interrupt).mockClear()
    vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: 'deny' } as never)
    projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'bearcode-fap-')))
    mkdirSync(join(projectPath, 'a'))
    writeFileSync(join(projectPath, 'a', 'b.txt'), 'inside')
    shared = fakeShared()
    gated = new GatedDiffFsBackend(shared as unknown as DiffFsBackend, 'tc1', 'convo', projectPath)
  })

  it('deny (default): an outside-root read is rejected, shared read untouched', async () => {
    const r = await gated.read('../outside.txt')
    expect(r).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(shared.read).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('allow: an outside-root read is permitted (threads allowOutsideRead=true)', async () => {
    vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: 'allow' } as never)
    await gated.read('../outside.txt', 0, 500)
    expect(shared.read).toHaveBeenCalledWith('../outside.txt', 0, 500, true)
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('ask: an outside-root read raises a read_file approval card; approved → permitted', async () => {
    vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: 'ask' } as never)
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await gated.read('../outside.txt')
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'read_file',
      tool: 'read_file',
      path: '../outside.txt',
      resolvedPath: expect.stringContaining('outside.txt'),
      toolCallId: 'tc1'
    })
    expect(shared.read).toHaveBeenCalledWith('../outside.txt', undefined, undefined, true)
  })

  it('ask: a denied approval blocks the read', async () => {
    vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: 'ask' } as never)
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const r = await gated.read('../outside.txt')
    expect(r).toEqual({ error: 'User denied reading this path.' })
    expect(shared.read).not.toHaveBeenCalled()
  })

  it('inside-root reads are UNCHANGED under every policy (no prompt, no relaxation flag)', async () => {
    for (const policy of ['deny', 'ask', 'allow'] as const) {
      vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: policy } as never)
      shared.read.mockClear()
      vi.mocked(interrupt).mockClear()
      await gated.read('a/b.txt', 0, 500)
      expect(shared.read).toHaveBeenCalledWith('a/b.txt', 0, 500, false)
      expect(interrupt).not.toHaveBeenCalled()
    }
  })

  it("SECURITY REGRESSION: a WRITE outside root is rejected even under 'allow'", async () => {
    vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: 'allow' } as never)
    const w = await gated.write('../escape.txt', 'x')
    expect(w).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(shared.write).not.toHaveBeenCalled()
    const e = await gated.edit('../escape.txt', 'a', 'b')
    expect(e).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(shared.edit).not.toHaveBeenCalled()
  })

  it('jailPath: no opts throws outside; allowOutsideRead returns the resolved path', () => {
    expect(() => jailPath(projectPath, '../escape.txt')).toThrow(/outside the workspace/)
    // allowOutsideRead lets the resolution through (used only by read delegations).
    expect(jailPath(projectPath, '../escape.txt', { allowOutsideRead: true })).toContain(
      'escape.txt'
    )
    // Inside-root is unchanged regardless of the flag.
    expect(jailPath(projectPath, 'a/b.txt')).toBe(join(projectPath, 'a', 'b.txt'))
  })
})

// Task 8 review fix: createDeepAgent() generates ls/read_file/write_file/
// edit_file/glob/grep INTERNALLY (createFilesystemMiddleware(backend)) and
// never routes them through graph.ts's wrapToolsWithHooks, so a hook whose
// matcher targets any of those tool names silently never fired -- including
// the design doc's own flagship "format-on-edit" example. These tests prove
// GatedDiffFsBackend now runs the identical PreToolUse/PostToolUse gating
// wrap.ts runs for every custom tool.
describe('GatedDiffFsBackend hook gating (Task 8 review fix)', () => {
  let projectPath: string
  let shared: ReturnType<typeof fakeShared>
  let gated: GatedDiffFsBackend
  const hookCtx = { conversationId: 'convo', projectPath: '/proj', trusted: true }

  beforeEach(() => {
    clearDeniedReplayPins('convo')
    mockRunPreToolUse.mockReset().mockResolvedValue({ decision: 'allow' })
    mockRunPostToolUse.mockReset().mockResolvedValue(undefined)
    vi.mocked(evaluateEditForConversation).mockClear().mockReturnValue('apply')
    vi.mocked(getSettings).mockReturnValue({ fileAccessPolicy: 'deny' } as never)
    vi.mocked(interrupt).mockClear()
    projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'bearcode-hookgate-')))
    mkdirSync(join(projectPath, 'a'))
    writeFileSync(join(projectPath, 'a', 'b.txt'), 'hello')
    shared = fakeShared()
    gated = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc1',
      'convo',
      projectPath,
      hookCtx
    )
  })

  it('a plain 4-arg construction (hookCtx unset) never consults the hooks layer at all', async () => {
    const noHooks = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc1',
      'convo',
      projectPath
    )
    await noHooks.write('a/b.txt', 'new')
    await noHooks.ls('a')
    expect(mockRunPreToolUse).not.toHaveBeenCalled()
    expect(mockRunPostToolUse).not.toHaveBeenCalled()
  })

  it('PreToolUse deny on write_file short-circuits BEFORE the edit-rule engine, shared never called', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'deny', reason: 'no writes to secrets' })
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ error: 'no writes to secrets' })
    expect(mockRunPreToolUse).toHaveBeenCalledWith(
      'write_file',
      { file_path: 'a/b.txt', content: 'new' },
      hookCtx
    )
    // Hooks run BEFORE the base gate -- the rules engine must never even run.
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
    expect(shared.write).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('PreToolUse ask on edit_file raises the hook_ask interrupt contract; approved proceeds to the base gate', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'ask', reason: 'confirm this edit' })
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await gated.edit('a/b.txt', 'hello', 'goodbye')
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'hook_ask',
      tool: 'edit_file',
      input: {
        file_path: 'a/b.txt',
        old_string: 'hello',
        new_string: 'goodbye',
        replace_all: false
      },
      reason: 'confirm this edit',
      toolCallId: 'tc1'
    })
    // Allowed by the hook -> the base 'apply' decision still runs and delegates.
    expect(evaluateEditForConversation).toHaveBeenCalled()
    expect(shared.edit).toHaveBeenCalledWith('a/b.txt', 'hello', 'goodbye', false)
  })

  it('PreToolUse ask denied by the user blocks the write, base gate never reached', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'ask' })
    vi.mocked(interrupt).mockReturnValue({ approved: false })
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ error: 'User denied this action.' })
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('a throwing hooks layer fails OPEN: the base gate still runs normally', async () => {
    mockRunPreToolUse.mockRejectedValue(new Error('hooks layer exploded'))
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ path: 'x', filesUpdate: null })
    expect(shared.write).toHaveBeenCalledWith('a/b.txt', 'new')
  })

  it('fires PostToolUse after a successful write, never awaited into the return path', async () => {
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ path: 'x', filesUpdate: null })
    expect(mockRunPostToolUse).toHaveBeenCalledWith(
      'write_file',
      { file_path: 'a/b.txt', content: 'new' },
      true,
      { path: 'x', filesUpdate: null },
      hookCtx
    )
  })

  it('does NOT fire PostToolUse when the hook denied the call (original never ran)', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'deny', reason: 'no' })
    await gated.write('a/b.txt', 'new')
    expect(mockRunPostToolUse).not.toHaveBeenCalled()
  })

  it('a denied-replay pin (byHookToolCallId) blocks the replay BEFORE runPreToolUse is even consulted', async () => {
    // Mirrors wrap.test.ts's identical case: on a keyed-resume replay this
    // whole path re-runs from the top; a hook-ask card the user denied must
    // win even if runPreToolUse would now return a different decision.
    pinDeniedReplays('convo', [{ toolCallId: 'tc1' }])
    const result = await gated.write('a/b.txt', 'new')
    expect(result).toEqual({ error: 'User denied this action.' })
    expect(mockRunPreToolUse).not.toHaveBeenCalled()
    expect(shared.write).not.toHaveBeenCalled()

    // Take-once (byHookToolCallId specifically): a genuinely UNRELATED call
    // (a fresh toolCallId the pin never touched) is not silently denied by
    // the hooks layer -- pinDeniedReplays also populates the write gate's
    // OWN byToolCallId pin from the same denied card (tools.ts's shared
    // discipline: every denied toolCallId is recorded in BOTH namespaces),
    // so a same-toolCallId retry is deliberately still blocked one more time
    // by takeDeniedEditReplayPin -- that double-consumption is covered by
    // the existing 'a consumed pin never denies a later identical write'
    // case above for the base gate's own pin.
    const other = new GatedDiffFsBackend(
      shared as unknown as DiffFsBackend,
      'tc-other',
      'convo',
      projectPath,
      hookCtx
    )
    const result2 = await other.write('a/b.txt', 'newer')
    expect(result2).toEqual({ path: 'x', filesUpdate: null })
    expect(mockRunPreToolUse).toHaveBeenCalledTimes(1)
  })

  // The whole point of this fixer pass: the BUILT-IN read tools (ls/
  // read_file/grep/glob) never routed through wrapToolsWithHooks either, so
  // they must get the identical treatment as write/edit above.
  it('gates ls() (a built-in read tool) through PreToolUse deny', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'deny', reason: 'no directory listing' })
    const result = await gated.ls('a')
    expect(result).toEqual({ error: 'no directory listing' })
    expect(mockRunPreToolUse).toHaveBeenCalledWith('ls', { path: 'a' }, hookCtx)
    expect(shared.ls).not.toHaveBeenCalled()
  })

  it('gates read() through PreToolUse ask -> approved proceeds to the shared read', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'ask', reason: 'reading a sensitive file' })
    vi.mocked(interrupt).mockReturnValue({ approved: true })
    await gated.read('a/b.txt', 0, 10)
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'hook_ask',
      tool: 'read_file',
      input: { file_path: 'a/b.txt', offset: 0, limit: 10 },
      reason: 'reading a sensitive file',
      toolCallId: 'tc1'
    })
    expect(shared.read).toHaveBeenCalledWith('a/b.txt', 0, 10, false)
  })

  it('gates grep()/glob() through PreToolUse deny, matching field names hooks would author matchers against', async () => {
    mockRunPreToolUse.mockResolvedValue({ decision: 'deny', reason: 'no' })
    await gated.grep('needle', 'a', '*.txt')
    expect(mockRunPreToolUse).toHaveBeenCalledWith(
      'grep',
      { pattern: 'needle', path: 'a', glob: '*.txt' },
      hookCtx
    )
    expect(shared.grep).not.toHaveBeenCalled()
    await gated.glob('**/*.txt', 'a')
    expect(mockRunPreToolUse).toHaveBeenCalledWith(
      'glob',
      { pattern: '**/*.txt', path: 'a' },
      hookCtx
    )
    expect(shared.glob).not.toHaveBeenCalled()
  })

  it('fires PostToolUse after a successful read-side delegation too', async () => {
    await gated.grep('needle', 'a', null)
    expect(mockRunPostToolUse).toHaveBeenCalledWith(
      'grep',
      { pattern: 'needle', path: 'a', glob: null },
      true,
      { matches: [] },
      hookCtx
    )
  })

  it('an allowed hook still lets the OUTSIDE-workspace read policy (F8) run afterward', async () => {
    // Hooks are additive, layered IN FRONT of the base gate -- an 'allow'
    // from the hooks layer must not relax the outside-root deny below it.
    mockRunPreToolUse.mockResolvedValue({ decision: 'allow' })
    const result = await gated.read('../outside.txt')
    expect(result).toEqual({ error: expect.stringContaining('outside the workspace') })
    expect(shared.read).not.toHaveBeenCalled()
  })
})
