import { describe, it, expect } from 'vitest'
import type { CommandEntry } from '@shared/types'
import { filterSlashCommands } from './slashFilter'

function entry(name: string, kind: CommandEntry['kind'] = 'workflow'): CommandEntry {
  return { name, description: '', kind, status: 'live' }
}

describe('filterSlashCommands', () => {
  it('returns all entries unchanged for an empty query', () => {
    const entries = [entry('goal', 'builtin'), entry('resume', 'builtin'), entry('release-check')]
    expect(filterSlashCommands('', entries)).toEqual(entries)
  })

  it('ranks a prefix match above a substring match above a subsequence match', () => {
    const abc = entry('abc')
    const cab = entry('cab')
    const xaxbxc = entry('xaxbxc')
    const result = filterSlashCommands('ab', [cab, xaxbxc, abc])
    expect(result.map((e) => e.name)).toEqual(['abc', 'cab', 'xaxbxc'])
  })

  it('matches case-insensitively', () => {
    const goal = entry('goal', 'builtin')
    expect(filterSlashCommands('GOA', [goal])).toEqual([goal])
    expect(filterSlashCommands('goa', [goal])).toEqual([goal])
  })

  it('preserves built-ins-before-workflows group order even when a workflow ranks better', () => {
    // "goal" (builtin) only substring-matches "oa"; "oa-flow" (workflow) is a
    // prefix match, which would normally rank first, but the built-in group
    // must still come entirely before the workflow group.
    const goal = entry('goal', 'builtin')
    const oaFlow = entry('oa-flow', 'workflow')
    const result = filterSlashCommands('oa', [goal, oaFlow])
    expect(result.map((e) => e.name)).toEqual(['goal', 'oa-flow'])
  })

  it('excludes entries that do not even subsequence-match the query', () => {
    const goal = entry('goal', 'builtin')
    const zzz = entry('zzz', 'builtin')
    const result = filterSlashCommands('goal', [zzz, goal])
    expect(result.map((e) => e.name)).toEqual(['goal'])
  })

  it('keeps status/error/source fields intact on returned entries', () => {
    const broken: CommandEntry = {
      name: 'broken',
      description: '',
      kind: 'workflow',
      status: 'coming-soon',
      error: 'workflow file is empty'
    }
    expect(filterSlashCommands('bro', [broken])).toEqual([broken])
  })
})
