import { describe, it, expect } from 'vitest'
import { assembleRuleAdditions, withoutModelRules, type RuleAssemblyInput } from './contextAssembly'
import type { AgentsContent, Rule } from '../agentsDir/types'

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
  content: AgentsContent,
  overrides: Partial<RuleAssemblyInput> = {}
): RuleAssemblyInput => ({
  content,
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
    const result = withoutModelRules({ rules: [always, manual, glob, model], workflows: [] })
    expect(result.rules.map((r) => r.name)).toEqual(['a1', 'm1', 'g1'])
  })

  it('preserves the workflows field untouched (the spread carries it through)', () => {
    const always = rule({ name: 'a1' })
    const workflows: AgentsContent['workflows'] = [
      { name: 'wf', description: '', body: 'step', steps: ['step'], source: 'project' }
    ]
    const result = withoutModelRules({ rules: [always], workflows })
    expect(result.workflows).toBe(workflows)
  })

  it('never renders the "## Available rules" index once filtered', () => {
    const model = rule({ name: 'mod1', activation: 'model', description: 'desc' })
    const filtered = withoutModelRules({ rules: [model], workflows: [] })
    const result = assembleRuleAdditions(input(filtered))
    expect(result.systemAdditions).toEqual([])
  })

  it('is a no-op when there are no model rules', () => {
    const always = rule({ name: 'a1' })
    const result = withoutModelRules({ rules: [always], workflows: [] })
    expect(result.rules.map((r) => r.name)).toEqual(['a1'])
  })
})
