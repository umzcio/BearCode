import type { ManualRuleInfo, MentionRef } from '@shared/types'

// One @ menu row. `label` is the display text (file path / rule name / convo
// title); `detail` is the rule's first body line. `ref` is the structured
// MentionRef added to the composer's pill list on select.
export interface MentionSuggestion {
  ref: MentionRef
  label: string
  detail?: string
}

// The active @-mention token under the caret, or null. An @ begins a token
// only at text start or after whitespace (so `me@host` is NOT a mention), and
// the query (@ up to the caret) must contain no whitespace. Pure.
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i === 0 ? ' ' : text[i - 1]
      if (i === 0 || /\s/.test(prev)) return { start: i, query: text.slice(i + 1, caret) }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

function isSubsequence(query: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < query.length; j++) {
    if (hay[j] === query[i]) i++
  }
  return i === query.length
}

export interface BuildMentionSuggestionsOpts {
  query: string
  files: string[]
  rules: ManualRuleInfo[]
  conversations: { id: string; title: string }[]
}

// Concatenate the three categories in fixed order (Files, Rules,
// Conversations). Files arrive already ranked from the IPC read model, so they
// pass through unfiltered; rules + conversations are filtered client-side by a
// case-insensitive subsequence match on their label. Pure.
export function buildMentionSuggestions(opts: BuildMentionSuggestionsOpts): MentionSuggestion[] {
  const q = opts.query.toLowerCase()
  const match = (label: string): boolean => q === '' || isSubsequence(q, label.toLowerCase())

  const fileItems: MentionSuggestion[] = opts.files.map((path) => ({
    ref: { kind: 'file', name: path, path },
    label: path
  }))
  const ruleItems: MentionSuggestion[] = opts.rules
    .filter((r) => match(r.name))
    .map((r) => ({ ref: { kind: 'rule', name: r.name }, label: r.name, detail: r.firstLine || undefined }))
  const convoItems: MentionSuggestion[] = opts.conversations
    .filter((c) => match(c.title))
    .map((c) => ({ ref: { kind: 'conversation', name: c.title, conversationId: c.id }, label: c.title }))

  return [...fileItems, ...ruleItems, ...convoItems]
}
