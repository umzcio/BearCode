export interface ConflictHunk {
  ours: string
  theirs: string
  base?: string
}
export type ResolvedChoice = 'ours' | 'theirs'

const START = /^<{7}\s?/
const MID = /^={7}\s*$/
const END = /^>{7}\s?/
const BASE = /^\|{7}\s?/

export function parseConflicts(text: string): { hunks: ConflictHunk[]; hasConflicts: boolean } {
  const lines = text.split('\n')
  const hunks: ConflictHunk[] = []
  let i = 0
  while (i < lines.length) {
    if (START.test(lines[i])) {
      const ours: string[] = []
      const theirs: string[] = []
      const base: string[] = []
      let section: 'ours' | 'base' | 'theirs' = 'ours'
      i++
      while (i < lines.length && !END.test(lines[i])) {
        if (BASE.test(lines[i])) section = 'base'
        else if (MID.test(lines[i])) section = 'theirs'
        else (section === 'ours' ? ours : section === 'base' ? base : theirs).push(lines[i])
        i++
      }
      hunks.push({
        ours: ours.join('\n'),
        theirs: theirs.join('\n'),
        base: base.length ? base.join('\n') : undefined
      })
    }
    i++
  }
  return { hunks, hasConflicts: hunks.length > 0 }
}

export function applyChoice(text: string, choice: ResolvedChoice): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (START.test(lines[i])) {
      const ours: string[] = []
      const theirs: string[] = []
      let section: 'ours' | 'base' | 'theirs' = 'ours'
      i++
      while (i < lines.length && !END.test(lines[i])) {
        if (BASE.test(lines[i])) section = 'base'
        else if (MID.test(lines[i])) section = 'theirs'
        else if (section === 'ours') ours.push(lines[i])
        else if (section === 'theirs') theirs.push(lines[i])
        i++
      }
      out.push(...(choice === 'ours' ? ours : theirs))
    } else {
      out.push(lines[i])
    }
    i++
  }
  return out.join('\n')
}
