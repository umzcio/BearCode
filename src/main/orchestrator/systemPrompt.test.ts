// orchestratorSystemPrompt is pure (no Electron, no DB, no model). The
// execution-mode prompt frame was retired in mode-picker phase 1; the
// plan-mode frame returns in phase 2. These tests pin that the base
// build-with-tools framing survives and that no "Execution mode:" block leaks.
import { describe, it, expect } from 'vitest'
import { orchestratorSystemPrompt } from './systemPrompt'

describe('orchestratorSystemPrompt', () => {
  it('a workspace conversation gets the build-with-tools framing, no execution-mode block', () => {
    const prompt = orchestratorSystemPrompt('/tmp/proj')
    expect(prompt).toContain('build with your tools, never paste code in chat')
    expect(prompt).not.toContain('Execution mode:')
  })
  it('no workspace: tells the user to open a folder, still no execution-mode block', () => {
    const prompt = orchestratorSystemPrompt(null)
    expect(prompt).toContain('No workspace folder is open')
    expect(prompt).not.toContain('Execution mode:')
  })
  it('SECURITY: the Bb permission framing is present with a workspace', () => {
    expect(orchestratorSystemPrompt('/tmp/proj')).toContain(
      "require the user's approval before they run and can be denied"
    )
  })
  it('plan mode re-adds the planning frame (research, submit_plan, submit_walkthrough)', () => {
    const prompt = orchestratorSystemPrompt('/tmp/proj', true)
    expect(prompt).toContain('PLAN MODE')
    expect(prompt).toContain('submit_plan BEFORE')
    expect(prompt).toContain('submit_walkthrough')
    // The plan frame must not resurrect the retired execution-mode block.
    expect(prompt).not.toContain('Execution mode:')
  })
  it('non-plan modes emit NO planning frame (default isPlan=false)', () => {
    const prompt = orchestratorSystemPrompt('/tmp/proj')
    expect(prompt).not.toContain('PLAN MODE')
    expect(prompt).not.toContain('submit_plan')
  })
  it('plan frame appears even with no workspace (isPlan=true, projectPath=null)', () => {
    expect(orchestratorSystemPrompt(null, true)).toContain('PLAN MODE')
  })
})
