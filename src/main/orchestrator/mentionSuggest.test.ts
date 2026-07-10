import { describe, it, expect } from 'vitest'
import { rankFilePaths, manualRuleInfos } from './mentionSuggest'
import type { AgentsContent, Rule } from '../agentsDir/types'

const rule = (over: Partial<Rule> = {}): Rule => ({
  name: 'r',
  body: 'body',
  activation: 'always',
  globs: [],
  description: '',
  source: 'project',
  ...over
})

describe('rankFilePaths', () => {
  const paths = ['src/components/Composer.tsx', 'src/store.ts', 'README.md', 'src/comp/util.ts']

  it('returns every path unchanged for an empty query', () => {
    expect(rankFilePaths(paths, '')).toEqual(paths)
  })

  it('ranks basename prefix matches above deeper subsequence matches', () => {
    const out = rankFilePaths(paths, 'comp')
    expect(out[0]).toBe('src/components/Composer.tsx')
    expect(out).toContain('src/comp/util.ts')
  })

  it('drops paths that do not even subsequence-match', () => {
    expect(rankFilePaths(paths, 'zzz')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(rankFilePaths(paths, 'README')).toContain('README.md')
  })
})

describe('manualRuleInfos', () => {
  it('returns only non-error manual rules with their first non-empty body line', () => {
    const content: AgentsContent = {
      rules: [
        rule({ name: 'style', activation: 'manual', body: '\nUse tabs.\nMore.' }),
        rule({ name: 'always-on', activation: 'always' }),
        rule({ name: 'broken', activation: 'manual', error: 'bad' } as Partial<Rule>),
        rule({ name: 'model-rule', activation: 'model' })
      ],
      workflows: [],
      skills: []
    }
    expect(manualRuleInfos(content)).toEqual([{ name: 'style', firstLine: 'Use tabs.' }])
  })

  it('returns an empty firstLine when the body is blank', () => {
    const content: AgentsContent = {
      rules: [rule({ name: 'empty', activation: 'manual', body: '   \n' })],
      workflows: [],
      skills: []
    }
    expect(manualRuleInfos(content)).toEqual([{ name: 'empty', firstLine: '' }])
  })
})
