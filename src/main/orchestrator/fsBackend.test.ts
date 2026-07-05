import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// fsBackend.ts imports ../permissions and ../diffs, both of which reach
// ../db (electron/sqlite at call time); mock them so importing the module
// under test never opens a real database, and so the gate's rules-engine
// calls are observable (same idiom as tools.test.ts).
vi.mock('../permissions', () => ({
  evaluateEditForConversation: vi.fn(() => 'apply')
}))
vi.mock('../diffs', () => ({
  stageFile: vi.fn()
}))
// Keep the real @langchain/langgraph module (GraphInterrupt/isGraphInterrupt
// must be the genuine classes) and stub ONLY interrupt(), which would
// otherwise throw outside a running graph. This is not a mock LangGraph --
// just the same injection seam the runtime uses.
vi.mock('@langchain/langgraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph')>()
  return { ...actual, interrupt: vi.fn() }
})

import { GraphInterrupt, interrupt, isGraphInterrupt } from '@langchain/langgraph'
import { evaluateEditForConversation } from '../permissions'
import type { DiffFsBackend } from './fsBackend'
import { GatedDiffFsBackend, relForGate } from './fsBackend'

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
    vi.mocked(evaluateEditForConversation).mockClear()
    vi.mocked(evaluateEditForConversation).mockReturnValue('apply')
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
    await gated.ls('a')
    expect(shared.ls).toHaveBeenCalledWith('a')
    await gated.read('a/b.txt', 3, 7)
    expect(shared.read).toHaveBeenCalledWith('a/b.txt', 3, 7)
    await gated.readRaw('a/b.txt')
    expect(shared.readRaw).toHaveBeenCalledWith('a/b.txt')
    await gated.grep('needle', 'a', '*.txt')
    expect(shared.grep).toHaveBeenCalledWith('needle', 'a', '*.txt')
    await gated.glob('**/*.txt', 'a')
    expect(shared.glob).toHaveBeenCalledWith('**/*.txt', 'a')
    // None of the read-side delegations consult the gate.
    expect(evaluateEditForConversation).not.toHaveBeenCalled()
  })
})
