// orchestratorSystemPrompt is pure (no Electron, no DB, no model). The
// execution-mode prompt frame was retired in mode-picker phase 1; the
// plan-mode frame returns in phase 2. These tests pin that the base
// build-with-tools framing survives and that no "Execution mode:" block leaks.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { orchestratorSystemPrompt, personalizationBlock } from './systemPrompt'

// orchestratorSystemPrompt reads live settings via getSettings() to fold in the
// user's profile + custom instructions. Mock the settings module so these tests
// stay pure (no Electron, no file I/O) and can drive the personalization path.
const h = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../settings', () => ({ getSettings: () => h.settings }))

beforeEach(() => {
  h.settings = {}
})

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
  it('folds live personalization (name + custom instructions) into the prompt', () => {
    h.settings = { profileName: 'Zach', customInstructions: 'Always use TS.' }
    const prompt = orchestratorSystemPrompt('/tmp/proj')
    expect(prompt).toContain('Zach')
    expect(prompt).toContain('Always use TS.')
  })
  it('adds nothing when no personalization is set', () => {
    const withEmpty = orchestratorSystemPrompt('/tmp/proj')
    expect(withEmpty).not.toContain("The user's name is")
    expect(withEmpty).not.toContain('custom instructions')
  })
})

describe('personalizationBlock', () => {
  it('returns [] when all fields are empty/absent', () => {
    expect(personalizationBlock({})).toEqual([])
    expect(
      personalizationBlock({ profileName: '', profileCallMe: '', customInstructions: '' })
    ).toEqual([])
    expect(personalizationBlock({ profileName: '   ' })).toEqual([])
  })
  it('emits a name line containing the name', () => {
    const lines = personalizationBlock({ profileName: 'Zach' })
    expect(lines.some((l) => l.includes('Zach'))).toBe(true)
    expect(lines.some((l) => l.includes("The user's name is Zach"))).toBe(true)
  })
  it('emits an address-as line for profileCallMe', () => {
    const lines = personalizationBlock({ profileCallMe: 'Z' })
    expect(lines.some((l) => l.includes('Address the user as Z'))).toBe(true)
  })
  it('emits a headed custom-instructions block with the text verbatim', () => {
    const lines = personalizationBlock({ customInstructions: 'Always use TS.' })
    expect(lines.some((l) => l.includes('custom instructions'))).toBe(true)
    expect(lines).toContain('Always use TS.')
  })
  it('combines all three when present', () => {
    const text = personalizationBlock({
      profileName: 'Zach',
      profileCallMe: 'Z',
      customInstructions: 'Always use TS.'
    }).join('\n')
    expect(text).toContain("The user's name is Zach")
    expect(text).toContain('Address the user as Z')
    expect(text).toContain('Always use TS.')
  })
})
