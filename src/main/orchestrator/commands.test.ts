import { describe, it, expect } from 'vitest'
import {
  BUILTIN_COMMANDS,
  MAX_WORKFLOW_INCLUSIONS,
  listCommands,
  resolveWorkflowSteps
} from './commands'
import type { AgentsContent, Workflow } from '../agentsDir/types'

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  name: 'wf',
  description: '',
  body: 'step',
  steps: ['step'],
  source: 'project',
  ...overrides
})

const content = (workflows: Workflow[]): AgentsContent => ({ rules: [], workflows })

describe('listCommands', () => {
  it('lists the built-ins first, in fixed order, when there are no workflows', () => {
    const result = listCommands(content([]))
    expect(result).toEqual(BUILTIN_COMMANDS)
  })

  it('lists non-erroring workflows alphabetically after the built-ins', () => {
    const b = workflow({ name: 'beta', description: 'second' })
    const a = workflow({ name: 'alpha', description: 'first' })
    const result = listCommands(content([b, a]))
    expect(result.slice(BUILTIN_COMMANDS.length)).toEqual([
      { name: 'alpha', description: 'first', kind: 'workflow', status: 'live', source: 'project' },
      { name: 'beta', description: 'second', kind: 'workflow', status: 'live', source: 'project' }
    ])
  })

  it('greys a workflow whose name collides with a built-in, keeping its alphabetical place', () => {
    const a = workflow({ name: 'alpha' })
    const goal = workflow({ name: 'goal' })
    const z = workflow({ name: 'zeta' })
    const result = listCommands(content([z, goal, a]))
    const names = result.map((c) => c.name)
    expect(names).toEqual([...BUILTIN_COMMANDS.map((c) => c.name), 'alpha', 'goal', 'zeta'])
    const goalEntry = result.find((c) => c.name === 'goal' && c.kind === 'workflow')
    expect(goalEntry).toEqual({
      name: 'goal',
      description: '',
      kind: 'workflow',
      status: 'coming-soon',
      source: 'project',
      error: 'name collides with the built-in /goal'
    })
  })

  it('includes a parse-error workflow greyed with its error, in alphabetical place', () => {
    const broken = workflow({ name: 'broken', error: 'workflow file is empty', steps: [] })
    const result = listCommands(content([broken]))
    expect(result[BUILTIN_COMMANDS.length]).toEqual({
      name: 'broken',
      description: '',
      kind: 'workflow',
      status: 'coming-soon',
      source: 'project',
      error: 'workflow file is empty'
    })
  })
})

describe('resolveWorkflowSteps', () => {
  it('resolves a workflow with no references to its own steps', () => {
    const wf = workflow({ name: 'a', steps: ['do x', 'do y'] })
    const result = resolveWorkflowSteps('a', [wf])
    expect(result).toEqual({ ok: true, steps: ['do x', 'do y'] })
  })

  it('errors when the named workflow does not exist', () => {
    const result = resolveWorkflowSteps('missing', [])
    expect(result).toEqual({ ok: false, error: 'Workflow /missing does not exist' })
  })

  it('refuses a workflow with a parse error set, with that error', () => {
    const broken = workflow({ name: 'broken', error: 'workflow file is empty', steps: [] })
    const result = resolveWorkflowSteps('broken', [broken])
    expect(result).toEqual({ ok: false, error: 'workflow file is empty' })
  })

  it('refuses a workflow whose name collides with a built-in, with the collision error', () => {
    const goal = workflow({ name: 'goal', steps: ['do x'] })
    const result = resolveWorkflowSteps('goal', [goal])
    expect(result).toEqual({ ok: false, error: 'name collides with the built-in /goal' })
  })

  it('inlines a one-level reference (a step that is exactly /other-name)', () => {
    const inner = workflow({ name: 'inner', steps: ['inner step 1', 'inner step 2'] })
    const outer = workflow({ name: 'outer', steps: ['before', '/inner', 'after'] })
    const result = resolveWorkflowSteps('outer', [outer, inner])
    expect(result).toEqual({
      ok: true,
      steps: ['before', 'inner step 1', 'inner step 2', 'after']
    })
  })

  it('inlines nested references (outer -> mid -> inner)', () => {
    const inner = workflow({ name: 'inner', steps: ['leaf step'] })
    const mid = workflow({ name: 'mid', steps: ['/inner'] })
    const outer = workflow({ name: 'outer', steps: ['/mid'] })
    const result = resolveWorkflowSteps('outer', [outer, mid, inner])
    expect(result).toEqual({ ok: true, steps: ['leaf step'] })
  })

  it('trims the reference line before matching, so a leading/trailing space still resolves', () => {
    const inner = workflow({ name: 'inner', steps: ['leaf'] })
    const outer = workflow({ name: 'outer', steps: ['  /inner  '] })
    const result = resolveWorkflowSteps('outer', [outer, inner])
    expect(result).toEqual({ ok: true, steps: ['leaf'] })
  })

  it('errors when a step references a workflow that does not exist', () => {
    const outer = workflow({ name: 'outer', steps: ['/ghost'] })
    const result = resolveWorkflowSteps('outer', [outer])
    expect(result).toEqual({
      ok: false,
      error: 'Workflow /outer references /ghost, which does not exist'
    })
  })

  it('refuses a direct self-cycle naming the cycle', () => {
    const a = workflow({ name: 'a', steps: ['/a'] })
    const result = resolveWorkflowSteps('a', [a])
    expect(result).toEqual({
      ok: false,
      error: 'Workflow /a references /a, which creates a reference cycle'
    })
  })

  it('refuses a mutual cycle (loop-a -> loop-b -> loop-a) naming the cycle', () => {
    const loopA = workflow({ name: 'loop-a', steps: ['/loop-b'] })
    const loopB = workflow({ name: 'loop-b', steps: ['/loop-a'] })
    const result = resolveWorkflowSteps('loop-a', [loopA, loopB])
    expect(result).toEqual({
      ok: false,
      error: 'Workflow /loop-b references /loop-a, which creates a reference cycle'
    })
  })

  it('resolves a diamond expansion (a -> {b, c} -> d), inlining d once per branch, bounded', () => {
    const d = workflow({ name: 'd', steps: ['leaf'] })
    const b = workflow({ name: 'b', steps: ['/d'] })
    const c = workflow({ name: 'c', steps: ['/d'] })
    const a = workflow({ name: 'a', steps: ['/b', '/c'] })
    const result = resolveWorkflowSteps('a', [a, b, c, d])
    expect(result).toEqual({ ok: true, steps: ['leaf', 'leaf'] })
  })

  it('refuses past the inclusion ceiling on a long non-cycling chain', () => {
    // A linear chain of MAX_WORKFLOW_INCLUSIONS + 2 workflows (w0 -> w1 -> ...):
    // not a cycle, but more distinct inclusions than the ceiling allows.
    const count = MAX_WORKFLOW_INCLUSIONS + 2
    const chain: Workflow[] = []
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1
      chain.push(workflow({ name: `w${i}`, steps: isLast ? ['leaf'] : [`/w${i + 1}`] }))
    }
    const result = resolveWorkflowSteps('w0', chain)
    expect(result).toEqual({
      ok: false,
      error: `Workflow /w0 resolves past the workflow inclusion limit of ${MAX_WORKFLOW_INCLUSIONS}`
    })
  })

  it('allows a resolved body of exactly 11999 characters (under the 12,000 cap)', () => {
    const wf = workflow({ name: 'a', steps: ['x'.repeat(11999)] })
    const result = resolveWorkflowSteps('a', [wf])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.steps.join('\n').length).toBe(11999)
  })

  it('refuses a resolved body of 12001 characters (over the 12,000 cap) without exceeding it silently', () => {
    const wf = workflow({ name: 'a', steps: ['x'.repeat(12001)] })
    const result = resolveWorkflowSteps('a', [wf])
    expect(result).toEqual({
      ok: false,
      error: 'Workflow /a resolves past the 12,000 character limit'
    })
  })

  it('bails incrementally on a pathological expansion well past the cap, never materializing it', () => {
    // 50 steps of 1000 chars each (~50k joined) via nested references: the
    // incremental counter must bail long before the full text would exist.
    const leaf = workflow({ name: 'leaf', steps: Array(50).fill('y'.repeat(1000)) })
    const result = resolveWorkflowSteps('leaf', [leaf])
    expect(result).toEqual({
      ok: false,
      error: 'Workflow /leaf resolves past the 12,000 character limit'
    })
  })
})
