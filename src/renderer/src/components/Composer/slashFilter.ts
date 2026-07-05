import type { CommandEntry } from '@shared/types'

// Pure fuzzy filter for the slash menu (D2 design 6.1). Case-insensitive
// subsequence match on `name`; within each of the two fixed groups (built-ins,
// then workflows) matches rank prefix > substring > subsequence, but the
// group order itself is never disturbed -- a highly-ranked workflow can never
// float above the built-ins group. An entry that does not even
// subsequence-match the query is dropped. An empty query returns every entry
// unchanged (no ranking work, no reordering).

function isSubsequence(query: string, name: string): boolean {
  let i = 0
  for (let j = 0; j < name.length && i < query.length; j++) {
    if (name[j] === query[i]) i++
  }
  return i === query.length
}

// Lower is better. null = no match at all (excluded).
function rank(name: string, query: string): number | null {
  if (name.startsWith(query)) return 0
  if (name.includes(query)) return 1
  if (isSubsequence(query, name)) return 2
  return null
}

function rankGroup(group: CommandEntry[], query: string): CommandEntry[] {
  return group
    .map((entry, index) => ({ entry, index, score: rank(entry.name.toLowerCase(), query) }))
    .filter(
      (scored): scored is { entry: CommandEntry; index: number; score: number } =>
        scored.score !== null
    )
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.index - b.index))
    .map((scored) => scored.entry)
}

export function filterSlashCommands(query: string, entries: CommandEntry[]): CommandEntry[] {
  if (query === '') return entries
  const lowerQuery = query.toLowerCase()
  const builtins = entries.filter((e) => e.kind === 'builtin')
  const workflows = entries.filter((e) => e.kind === 'workflow')
  return [...rankGroup(builtins, lowerQuery), ...rankGroup(workflows, lowerQuery)]
}
