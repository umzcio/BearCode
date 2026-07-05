// Pins the execution-mode prompt additions (design 3.2/3.1) pure: no Electron,
// no DB, no model. These strings are the phase's core mechanism -- the smoke's
// plan -> pause -> proceed -> walkthrough flow must emerge from them without
// explicit tool instructions in the user prompt.
import { describe, it, expect } from 'vitest'
import { executionModeAdditions, orchestratorSystemPrompt } from './systemPrompt'

describe('executionModeAdditions', () => {
  const planning = executionModeAdditions('planning').join('\n')
  const fast = executionModeAdditions('fast').join('\n')

  it('planning: research first, then submit_plan BEFORE any change (design 3.2 ordering)', () => {
    expect(planning).toContain('Execution mode: PLANNING')
    expect(planning).toContain('Research first')
    // The plan is tied to the before-any-change clause, in that order.
    expect(planning).toMatch(/Before creating or editing ANY file[\s\S]*submit_plan/)
  })
  it('planning: wait for the review outcome before implementing', () => {
    expect(planning).toContain('on feedback, revise the plan and submit it again')
    expect(planning).toContain('Never start implementing while')
  })
  it('planning: keep todos current and finish with a walkthrough', () => {
    expect(planning).toContain('write_todos')
    expect(planning).toContain('finish by calling submit_walkthrough')
  })
  it('fast: never nudges a plan (submit_plan unmentioned, design 3.2)', () => {
    expect(fast).toContain('Execution mode: FAST')
    expect(fast).not.toContain('submit_plan')
  })
  it('fast: walkthrough only as the multi-file conditional (design 3.1 DOCUMENTED CHOICE)', () => {
    expect(fast).toContain('more than one file')
    expect(fast).toContain('submit_walkthrough')
    expect(fast).toContain('skip the walkthrough')
  })
})

describe('orchestratorSystemPrompt with execution modes', () => {
  it('appends exactly the picked mode block for a workspace conversation', () => {
    const planning = orchestratorSystemPrompt('/tmp/proj', 'planning')
    expect(planning).toContain('Execution mode: PLANNING')
    expect(planning).not.toContain('Execution mode: FAST')
    const fast = orchestratorSystemPrompt('/tmp/proj', 'fast')
    expect(fast).toContain('Execution mode: FAST')
    expect(fast).not.toContain('Execution mode: PLANNING')
  })
  it('adds NO mode block without a workspace: the artifact tools are not registered there', () => {
    for (const mode of ['planning', 'fast'] as const) {
      const prompt = orchestratorSystemPrompt(null, mode)
      expect(prompt).not.toContain('Execution mode:')
      expect(prompt).not.toContain('submit_plan')
    }
  })
  it('SECURITY: the Bb permission framing is untouched in both modes', () => {
    for (const mode of ['planning', 'fast'] as const) {
      expect(orchestratorSystemPrompt('/tmp/proj', mode)).toContain(
        "require the user's approval before they run and can be denied"
      )
    }
  })
})
