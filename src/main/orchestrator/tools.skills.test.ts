import { describe, it, expect, vi, beforeEach } from 'vitest'

// tools.ts's propose_skill tool pauses on interrupt() and writes through
// writeSkillFile on resume; stub both like tools.test.ts does for run_command
// (spread-importOriginal so the rest of each module stays live).
vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@langchain/langgraph')>()),
  interrupt: vi.fn()
}))
vi.mock('../skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skills')>()),
  writeSkillFile: vi.fn()
}))
vi.mock('../agentsDir', () => ({ loadAgentsContent: vi.fn() }))
import { interrupt } from '@langchain/langgraph'
import { writeSkillFile } from '../skills'
import { loadAgentsContent } from '../agentsDir'
import { buildSkillTools } from './tools'

const asContent = (
  skills: unknown[]
): { rules: unknown[]; workflows: unknown[]; skills: unknown[] } => ({
  rules: [],
  workflows: [],
  skills
})

// Test-only widening: activate_skill and propose_skill don't share an
// invoke signature (the tools.test.ts precedent for buildTools' own mixed
// array), and these tests only care about name + string result.
interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}
const skillTools = (projectPath: string | null): InvokableTool[] =>
  buildSkillTools('c1', projectPath) as unknown as InvokableTool[]

describe('activate_skill', () => {
  beforeEach(() => vi.mocked(loadAgentsContent).mockReset())

  it('returns the full body of a named, enabled, non-error skill', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue(
      asContent([{ name: 'pdf', description: 'x', body: 'FULL', source: 'global' }]) as never
    )
    const [activate] = skillTools(null)
    const out = await activate.invoke({ name: 'pdf' })
    expect(out).toContain('Skill pdf:')
    expect(out).toContain('FULL')
  })

  it('reports unknown skill with the available list', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue(
      asContent([{ name: 'pdf', description: 'x', body: 'B', source: 'global' }]) as never
    )
    const [activate] = skillTools(null)
    expect(await activate.invoke({ name: 'ghost' })).toMatch(/Unknown skill: ghost/)
  })

  it('never returns an errored skill', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue(
      asContent([
        { name: 'bad', description: '', body: 'B', source: 'project', error: 'no desc' }
      ]) as never
    )
    const [activate] = skillTools('/proj')
    expect(await activate.invoke({ name: 'bad' })).toMatch(/Unknown skill/)
  })
})

describe('propose_skill', () => {
  beforeEach(() => {
    vi.mocked(interrupt).mockReset()
    vi.mocked(writeSkillFile).mockReset()
  })

  it('pauses on interrupt() with the drafted name/description/body', async () => {
    vi.mocked(interrupt).mockReturnValue({ save: false })
    const [, propose] = skillTools(null)
    await propose.invoke({ name: 'commit-msgs', description: 'Write commit messages', body: 'B' })
    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'propose_skill',
        name: 'commit-msgs',
        description: 'Write commit messages',
        body: 'B'
      })
    )
  })

  it('discards without writing when the resolution is save:false', async () => {
    vi.mocked(interrupt).mockReturnValue({ save: false })
    const [, propose] = skillTools(null)
    const out = await propose.invoke({ name: 'n', description: 'd', body: 'b' })
    expect(out).toMatch(/discarded/)
    expect(writeSkillFile).not.toHaveBeenCalled()
  })

  it('writes the (possibly edited) resolution on save:true, using the resolution scope', async () => {
    vi.mocked(interrupt).mockReturnValue({
      save: true,
      name: 'edited-name',
      description: 'edited desc',
      body: 'edited body',
      scope: 'project'
    })
    const [, propose] = skillTools('/proj')
    const out = await propose.invoke({ name: 'orig', description: 'orig desc', body: 'orig body' })
    expect(writeSkillFile).toHaveBeenCalledWith(
      { name: 'edited-name', description: 'edited desc', body: 'edited body', scope: 'project' },
      '/proj'
    )
    expect(out).toMatch(/Saved skill "edited-name" \(project\)/)
  })

  it('reports a write failure without throwing', async () => {
    vi.mocked(interrupt).mockReturnValue({
      save: true,
      name: 'n',
      description: 'd',
      body: 'b',
      scope: 'global'
    })
    vi.mocked(writeSkillFile).mockImplementation(() => {
      throw new Error('disk full')
    })
    const [, propose] = skillTools(null)
    const out = await propose.invoke({ name: 'n', description: 'd', body: 'b' })
    expect(out).toMatch(/Could not save the skill: disk full/)
  })

  it('treats a null/undefined resolution as a discard (interrupted mid-flight)', async () => {
    vi.mocked(interrupt).mockReturnValue(undefined)
    const [, propose] = skillTools(null)
    const out = await propose.invoke({ name: 'n', description: 'd', body: 'b' })
    expect(out).toMatch(/discarded/)
    expect(writeSkillFile).not.toHaveBeenCalled()
  })
})
