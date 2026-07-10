import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../agentsDir', () => ({ loadAgentsContent: vi.fn() }))
import { loadAgentsContent } from '../agentsDir'
import { buildSkillTools } from './tools'

const asContent = (
  skills: unknown[]
): { rules: unknown[]; workflows: unknown[]; skills: unknown[] } => ({
  rules: [],
  workflows: [],
  skills
})

describe('activate_skill', () => {
  beforeEach(() => vi.mocked(loadAgentsContent).mockReset())

  it('returns the full body of a named, enabled, non-error skill', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue(
      asContent([{ name: 'pdf', description: 'x', body: 'FULL', source: 'global' }]) as never
    )
    const [activate] = buildSkillTools('c1', null)
    const out = await activate.invoke({ name: 'pdf' })
    expect(out).toContain('Skill pdf:')
    expect(out).toContain('FULL')
  })

  it('reports unknown skill with the available list', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue(
      asContent([{ name: 'pdf', description: 'x', body: 'B', source: 'global' }]) as never
    )
    const [activate] = buildSkillTools('c1', null)
    expect(await activate.invoke({ name: 'ghost' })).toMatch(/Unknown skill: ghost/)
  })

  it('never returns an errored skill', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue(
      asContent([
        { name: 'bad', description: '', body: 'B', source: 'project', error: 'no desc' }
      ]) as never
    )
    const [activate] = buildSkillTools('c1', '/proj')
    expect(await activate.invoke({ name: 'bad' })).toMatch(/Unknown skill/)
  })
})
