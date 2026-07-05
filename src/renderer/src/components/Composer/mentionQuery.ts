import type { ManualRuleInfo, MentionRef } from '@shared/types'

export type MentionKind = MentionRef['kind'] // 'file' | 'rule' | 'conversation'

// One concrete @ menu item. `label` is the display text (file path / rule name
// / convo title); `detail` is the rule's first body line. `ref` is the
// structured MentionRef added to the composer's pill list on select.
export interface MentionSuggestion {
  ref: MentionRef
  label: string
  detail?: string
}

// A row in the @ menu. On a bare `@` (no category chosen yet) the menu shows
// CATEGORY rows (Files / Rules / Conversations, like Antigravity); choosing one
// inserts an `@<kind>:` prefix and the menu then shows that category's ITEM
// rows. This keeps a bare `@` compact instead of dumping every file + rule +
// conversation at once.
export type MentionRow =
  | { type: 'category'; kind: MentionKind; label: string }
  | { type: 'item'; suggestion: MentionSuggestion }

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

const PREFIX_TO_KIND: Record<string, MentionKind> = {
  file: 'file',
  rule: 'rule',
  conversation: 'conversation'
}

// Split the text after `@` into an optional category prefix + the remaining
// sub-query. "conversation:cha" -> { category: 'conversation', sub: 'cha' };
// "conv" (no colon) -> { category: null, sub: 'conv' }. Pure.
export function parseMentionQuery(query: string): { category: MentionKind | null; sub: string } {
  const m = /^([a-zA-Z]+):(.*)$/.exec(query)
  if (m) {
    const kind = PREFIX_TO_KIND[m[1].toLowerCase()]
    if (kind) return { category: kind, sub: m[2] }
  }
  return { category: null, sub: query }
}

// The `@<kind>:` text inserted when a category row is chosen.
export function mentionCategoryPrefix(kind: MentionKind): string {
  return `${kind}:`
}

function isSubsequence(query: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < query.length; j++) {
    if (hay[j] === query[i]) i++
  }
  return i === query.length
}

const CATEGORIES: { kind: MentionKind; label: string }[] = [
  { kind: 'file', label: 'Files' },
  { kind: 'rule', label: 'Rules' },
  { kind: 'conversation', label: 'Conversations' }
]

// Keep the drilled-in item list compact (Antigravity shows a short list).
const ITEM_CAP = 8

export interface BuildMentionRowsOpts {
  category: MentionKind | null
  sub: string
  files: string[]
  rules: ManualRuleInfo[]
  conversations: { id: string; title: string }[]
}

// Category mode (no category chosen): the (sub-filtered) category chooser rows.
// Item mode: that category's items, sub-filtered and capped. Files arrive
// already ranked/filtered from the IPC read model, so they pass through; rules
// + conversations are filtered client-side by a case-insensitive subsequence
// match. Pure.
export function buildMentionRows(opts: BuildMentionRowsOpts): MentionRow[] {
  const q = opts.sub.toLowerCase()
  const match = (label: string): boolean => q === '' || isSubsequence(q, label.toLowerCase())

  if (opts.category === null) {
    return CATEGORIES.filter((c) => match(c.label)).map((c) => ({
      type: 'category' as const,
      kind: c.kind,
      label: c.label
    }))
  }

  let items: MentionSuggestion[]
  if (opts.category === 'file') {
    items = opts.files.map((path) => ({ ref: { kind: 'file', name: path, path }, label: path }))
  } else if (opts.category === 'rule') {
    items = opts.rules
      .filter((r) => match(r.name))
      .map((r) => ({ ref: { kind: 'rule', name: r.name }, label: r.name, detail: r.firstLine || undefined }))
  } else {
    items = opts.conversations
      .filter((c) => match(c.title))
      .map((c) => ({ ref: { kind: 'conversation', name: c.title, conversationId: c.id }, label: c.title }))
  }
  return items.slice(0, ITEM_CAP).map((s) => ({ type: 'item' as const, suggestion: s }))
}
