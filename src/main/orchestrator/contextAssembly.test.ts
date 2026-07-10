import { describe, it, expect } from 'vitest'
import {
  assembleRuleAdditions,
  withoutModelRules,
  assembleCommandAdditions,
  assembleUserMentions,
  mentionedFilePaths,
  mentionedRuleNames,
  mergeActiveRules,
  assembleSkillAdditions,
  mentionedSkillNames,
  assembleActivatedSkills,
  type RuleAssemblyInput,
  type UserMentionsDeps
} from './contextAssembly'
import type { AgentsContent, Rule, Workflow } from '../agentsDir/types'
import type { Skill } from '../agentsDir/types'
import type { CommandRef, MentionRef } from '../../shared/types'

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  name: 'r',
  body: 'body text',
  activation: 'always',
  globs: [],
  description: '',
  source: 'project',
  ...overrides
})

const input = (
  content: Partial<AgentsContent>,
  overrides: Partial<RuleAssemblyInput> = {}
): RuleAssemblyInput => ({
  content: { rules: [], workflows: [], skills: [], ...content },
  pinnedManualRules: [],
  mentionPaths: [],
  touchedFiles: [],
  ...overrides
})

describe('assembleRuleAdditions', () => {
  it('returns an empty systemAdditions for empty content', () => {
    const result = assembleRuleAdditions(input({ rules: [], workflows: [] }))
    expect(result).toEqual({ systemAdditions: [], activatedGlobRules: [] })
  })

  it('lists always-on rules under "## Project rules" with a name/source header', () => {
    const always = rule({ name: 'style', body: 'Use tabs.', source: 'global' })
    const result = assembleRuleAdditions(input({ rules: [always], workflows: [] }))
    expect(result.systemAdditions).toEqual([
      '',
      '## Project rules',
      '',
      '### style (global)',
      'Use tabs.'
    ])
  })

  it('lists pinned manual rules under "## Activated rules"', () => {
    const manual = rule({ name: 'checklist', activation: 'manual', body: 'Do the checklist.' })
    const result = assembleRuleAdditions(
      input({ rules: [manual], workflows: [] }, { pinnedManualRules: ['checklist'] })
    )
    expect(result.systemAdditions).toEqual([
      '',
      '## Activated rules',
      '',
      '### checklist (project)',
      'Do the checklist.'
    ])
  })

  it('does not activate a manual rule that is not pinned', () => {
    const manual = rule({ name: 'checklist', activation: 'manual' })
    const result = assembleRuleAdditions(input({ rules: [manual], workflows: [] }))
    expect(result.systemAdditions).toEqual([])
  })

  it('activates a glob rule whose pattern matches a touched file', () => {
    const glob = rule({ name: 'ts-rules', activation: 'glob', globs: ['src/**/*.ts'] })
    const result = assembleRuleAdditions(
      input({ rules: [glob], workflows: [] }, { touchedFiles: ['src/main/index.ts'] })
    )
    expect(result.systemAdditions).toEqual([
      '',
      '## Activated rules',
      '',
      '### ts-rules (project)',
      'body text'
    ])
    expect(result.activatedGlobRules).toEqual(['ts-rules'])
  })

  it('activates a glob rule whose pattern matches a mention path', () => {
    const glob = rule({ name: 'ts-rules', activation: 'glob', globs: ['*.ts'] })
    const result = assembleRuleAdditions(
      input({ rules: [glob], workflows: [] }, { mentionPaths: ['index.ts'] })
    )
    expect(result.activatedGlobRules).toEqual(['ts-rules'])
  })

  it('does not activate a glob rule with no matching path', () => {
    const glob = rule({ name: 'ts-rules', activation: 'glob', globs: ['*.ts'] })
    const result = assembleRuleAdditions(
      input({ rules: [glob], workflows: [] }, { touchedFiles: ['README.md'] })
    )
    expect(result.systemAdditions).toEqual([])
    expect(result.activatedGlobRules).toEqual([])
  })

  it('skips rules with error set in every section', () => {
    const always = rule({ name: 'broken', error: 'bad frontmatter' })
    const manual = rule({ name: 'broken-manual', activation: 'manual', error: 'bad' })
    const glob = rule({ name: 'broken-glob', activation: 'glob', globs: ['*'], error: 'bad' })
    const model = rule({
      name: 'broken-model',
      activation: 'model',
      description: 'x',
      error: 'bad'
    })
    const result = assembleRuleAdditions(
      input(
        { rules: [always, manual, glob, model], workflows: [] },
        { pinnedManualRules: ['broken-manual'], touchedFiles: ['anything'] }
      )
    )
    expect(result).toEqual({ systemAdditions: [], activatedGlobRules: [] })
  })

  it('renders a model-rule index only when model rules exist, with the activate_rule instruction', () => {
    const model = rule({
      name: 'refactor-guide',
      activation: 'model',
      description: 'How to refactor safely'
    })
    const result = assembleRuleAdditions(input({ rules: [model], workflows: [] }))
    expect(result.systemAdditions).toEqual([
      '',
      '## Available rules',
      '- refactor-guide: How to refactor safely',
      'Call the activate_rule tool with a rule name to load its full text when relevant.'
    ])
  })

  it('orders sections as always-on, then activated (manual + glob), then the model index', () => {
    const always = rule({ name: 'a1' })
    const manual = rule({ name: 'm1', activation: 'manual' })
    const glob = rule({ name: 'g1', activation: 'glob', globs: ['*.ts'] })
    const model = rule({ name: 'mod1', activation: 'model', description: 'desc' })
    const result = assembleRuleAdditions(
      input(
        { rules: [always, manual, glob, model], workflows: [] },
        { pinnedManualRules: ['m1'], touchedFiles: ['x.ts'] }
      )
    )
    const sectionOrder = result.systemAdditions.filter((line) => line.startsWith('## '))
    expect(sectionOrder).toEqual(['## Project rules', '## Activated rules', '## Available rules'])
    expect(result.activatedGlobRules).toEqual(['g1'])
  })
})

describe('withoutModelRules', () => {
  it('drops model-activation rules, leaving other activations untouched', () => {
    const always = rule({ name: 'a1' })
    const manual = rule({ name: 'm1', activation: 'manual' })
    const glob = rule({ name: 'g1', activation: 'glob', globs: ['*.ts'] })
    const model = rule({ name: 'mod1', activation: 'model', description: 'desc' })
    const result = withoutModelRules({
      rules: [always, manual, glob, model],
      workflows: [],
      skills: []
    })
    expect(result.rules.map((r) => r.name)).toEqual(['a1', 'm1', 'g1'])
  })

  it('preserves the workflows field untouched (the spread carries it through)', () => {
    const always = rule({ name: 'a1' })
    const workflows: AgentsContent['workflows'] = [
      { name: 'wf', description: '', body: 'step', steps: ['step'], source: 'project' }
    ]
    const result = withoutModelRules({ rules: [always], workflows, skills: [] })
    expect(result.workflows).toBe(workflows)
  })

  it('never renders the "## Available rules" index once filtered', () => {
    const model = rule({ name: 'mod1', activation: 'model', description: 'desc' })
    const filtered = withoutModelRules({ rules: [model], workflows: [], skills: [] })
    const result = assembleRuleAdditions(input(filtered))
    expect(result.systemAdditions).toEqual([])
  })

  it('is a no-op when there are no model rules', () => {
    const always = rule({ name: 'a1' })
    const result = withoutModelRules({ rules: [always], workflows: [], skills: [] })
    expect(result.rules.map((r) => r.name)).toEqual(['a1'])
  })
})

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  name: 'wf',
  description: '',
  body: 'step',
  steps: ['step'],
  source: 'project',
  ...overrides
})

const PRECEDENCE_SUBSTRING = 'take precedence over the execution mode'

describe('assembleCommandAdditions', () => {
  it('returns an empty systemAdditions and no error for a null command', () => {
    const result = assembleCommandAdditions(null, [])
    expect(result).toEqual({ systemAdditions: [] })
  })

  it('produces the /goal turn-modifier block ending with the precedence line', () => {
    const command: CommandRef = { name: 'goal', kind: 'builtin' }
    const result = assembleCommandAdditions(command, [])
    expect(result.error).toBeUndefined()
    const joined = result.systemAdditions.join('\n')
    expect(joined).toContain('Turn modifier: /goal.')
    expect(joined).toContain("Run until the user's stated goal is completely finished.")
    expect(joined).toContain('Do not stop to ask intermediate questions or wait for confirmation')
    expect(joined).toContain(PRECEDENCE_SUBSTRING)
    expect(result.systemAdditions.slice(-3)).toEqual([
      '',
      'For this turn, these command instructions take precedence over the execution mode',
      'instructions above wherever the two conflict.'
    ])
  })

  it('produces the /grill-me turn-modifier block ending with the precedence line', () => {
    const command: CommandRef = { name: 'grill-me', kind: 'builtin' }
    const result = assembleCommandAdditions(command, [])
    expect(result.error).toBeUndefined()
    const joined = result.systemAdditions.join('\n')
    expect(joined).toContain('Turn modifier: /grill-me.')
    expect(joined).toContain('interview the user to align')
    expect(joined).toContain('Do not create or edit any files')
    expect(joined).toContain(PRECEDENCE_SUBSTRING)
  })

  it('errors on an unknown or non-sendable builtin', () => {
    const command: CommandRef = { name: 'teamwork-preview', kind: 'builtin' }
    const result = assembleCommandAdditions(command, [])
    expect(result).toEqual({ systemAdditions: [], error: 'Unknown command: /teamwork-preview' })
  })

  it('produces the /browser delegation block steering to the browser subagent', () => {
    const command: CommandRef = { name: 'browser', kind: 'builtin' }
    const result = assembleCommandAdditions(command, [])
    expect(result.error).toBeUndefined()
    const joined = result.systemAdditions.join('\n')
    expect(joined).toContain('Turn modifier: /browser.')
    expect(joined).toContain('browser subagent')
    expect(joined).toContain('task')
    expect(joined).toContain('subagent_type')
    expect(joined).toContain('browser')
    expect(joined).toContain(PRECEDENCE_SUBSTRING)
  })

  it('allows /browser with no project folder open (browser tools are folder-independent)', () => {
    // The browser_* tools live in buildBrowserTools, which graph.ts wires in
    // unconditionally -- browsing has no project-folder dependency (session
    // data keys off conversationId, not projectPath). /browser must never
    // refuse for lack of a folder.
    const command: CommandRef = { name: 'browser', kind: 'builtin' }
    const result = assembleCommandAdditions(command, [])
    expect(result.error).toBeUndefined()
    expect(result.systemAdditions.join('\n')).toContain('Turn modifier: /browser.')
  })

  it('produces a workflow frame with numbered resolved steps, the write_todos bootstrap, and the precedence line', () => {
    const wf = workflow({ name: 'release-check', steps: ['first step', 'second step'] })
    const command: CommandRef = { name: 'release-check', kind: 'workflow' }
    const result = assembleCommandAdditions(command, [wf])
    expect(result.error).toBeUndefined()
    const joined = result.systemAdditions.join('\n')
    expect(joined).toContain(
      'You are executing the workflow "/release-check". Its steps, in order:'
    )
    expect(joined).toContain('1. first step')
    expect(joined).toContain('2. second step')
    expect(joined).toContain('Your FIRST tool call this turn MUST be write_todos')
    expect(joined).toContain('Do not call any other tool')
    expect(joined).toContain('before write_todos.')
    expect(joined).toContain(PRECEDENCE_SUBSTRING)
  })

  it('inlines a referenced workflow so no raw /other-name line survives in the frame', () => {
    const inner = workflow({ name: 'inner', steps: ['inner step'] })
    const outer = workflow({ name: 'nested', steps: ['/inner'] })
    const command: CommandRef = { name: 'nested', kind: 'workflow' }
    const result = assembleCommandAdditions(command, [outer, inner])
    const joined = result.systemAdditions.join('\n')
    expect(joined).toContain('1. inner step')
    expect(joined).not.toContain('/inner')
  })

  it('passes a resolveWorkflowSteps error through as the assembly error, with no system additions', () => {
    const loopA = workflow({ name: 'loop-a', steps: ['/loop-b'] })
    const loopB = workflow({ name: 'loop-b', steps: ['/loop-a'] })
    const command: CommandRef = { name: 'loop-a', kind: 'workflow' }
    const result = assembleCommandAdditions(command, [loopA, loopB])
    expect(result.systemAdditions).toEqual([])
    expect(result.error).toBe(
      'Workflow /loop-b references /loop-a, which creates a reference cycle'
    )
  })
})

describe('assembleUserMentions', () => {
  const noConvos: UserMentionsDeps = { conversationSummary: () => null }

  it('returns no additions for an empty mention list', () => {
    expect(assembleUserMentions([], noConvos).systemAdditions).toEqual([])
  })

  it('renders a Referenced files block from file mentions (path preferred)', () => {
    const mentions: MentionRef[] = [
      { kind: 'file', name: 'a.ts', path: 'src/a.ts' },
      { kind: 'file', name: 'src/b.ts' }
    ]
    const out = assembleUserMentions(mentions, noConvos).systemAdditions
    expect(out).toContain('## Referenced files')
    expect(out).toContain('- src/a.ts')
    expect(out).toContain('- src/b.ts')
  })

  it('renders a Referenced conversation block with the final answer', () => {
    const deps: UserMentionsDeps = {
      conversationSummary: (id) =>
        id === 'c1' ? { title: 'Auth refactor', finalAnswer: 'Done: moved to JWT.' } : null
    }
    const out = assembleUserMentions(
      [{ kind: 'conversation', name: 'Auth refactor', conversationId: 'c1' }],
      deps
    ).systemAdditions
    expect(out).toContain('## Referenced conversation: Auth refactor')
    expect(out).toContain('Done: moved to JWT.')
  })

  it('renders a placeholder when a referenced conversation has no final answer', () => {
    const deps: UserMentionsDeps = {
      conversationSummary: () => ({ title: 'Empty', finalAnswer: null })
    }
    const out = assembleUserMentions(
      [{ kind: 'conversation', name: 'Empty', conversationId: 'c9' }],
      deps
    ).systemAdditions
    expect(out.some((l) => l.includes('no final answer'))).toBe(true)
  })

  it('skips a conversation mention the deps cannot resolve', () => {
    expect(
      assembleUserMentions([{ kind: 'conversation', name: 'gone', conversationId: 'x' }], noConvos)
        .systemAdditions
    ).toEqual([])
  })
})

describe('mention rule helpers', () => {
  it('mentionedFilePaths returns path ?? name for file mentions only', () => {
    expect(
      mentionedFilePaths([
        { kind: 'file', name: 'a.ts', path: 'src/a.ts' },
        { kind: 'file', name: 'b.ts' },
        { kind: 'rule', name: 'style' }
      ])
    ).toEqual(['src/a.ts', 'b.ts'])
  })

  it('mentionedRuleNames returns names of rule mentions only', () => {
    expect(
      mentionedRuleNames([
        { kind: 'rule', name: 'style' },
        { kind: 'file', name: 'a.ts' },
        { kind: 'rule', name: 'security' }
      ])
    ).toEqual(['style', 'security'])
  })

  it('mergeActiveRules unions and de-duplicates preserving order', () => {
    expect(mergeActiveRules(['style'], ['style', 'security'])).toEqual(['style', 'security'])
  })
})

const sk = (
  name: string,
  description: string,
  body = 'BODY',
  source: 'project' | 'global' = 'project'
): Skill => ({ name, description, body, source }) as Skill

describe('assembleSkillAdditions', () => {
  it('renders a ## Available skills index with the activate_skill instruction', () => {
    const asm = assembleSkillAdditions([sk('pdf', 'Extract PDFs.', 'B', 'global')])
    const text = asm.systemAdditions.join('\n')
    expect(text).toContain('## Available skills')
    expect(text).toContain('### pdf (global)')
    expect(text).toContain('Extract PDFs.')
    expect(text).toMatch(/activate_skill/)
  })
  it('emits nothing when there are no enabled skills', () => {
    expect(assembleSkillAdditions([]).systemAdditions).toEqual([])
  })
})

describe('mentionedSkillNames', () => {
  it('returns names of kind skill only', () => {
    expect(
      mentionedSkillNames([
        { kind: 'skill', name: 'pdf' },
        { kind: 'rule', name: 'r' }
      ])
    ).toEqual(['pdf'])
  })
})

describe('assembleActivatedSkills', () => {
  it('injects the full body under ## Activated skills for a mentioned skill', () => {
    const asm = assembleActivatedSkills(['pdf'], [sk('pdf', 'x', 'FULL BODY')])
    const text = asm.systemAdditions.join('\n')
    expect(text).toContain('## Activated skills')
    expect(text).toContain('FULL BODY')
  })
  it('ignores a mentioned name that is not an enabled skill', () => {
    expect(assembleActivatedSkills(['ghost'], []).systemAdditions).toEqual([])
  })
})
