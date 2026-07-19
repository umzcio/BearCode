import type { SourceCitation } from '@shared/types'

// Providers (Perplexity) return their FULL search-result set while the answer
// cites an arbitrary subset in arbitrary order -- so the raw list reads as
// "starts at [2], #1 never cited". Present it the way the user reads it:
// only sources the text actually cites, ordered by first appearance,
// renumbered 1..k. `renumber` maps the model's original 1-based marker index
// to the displayed number so inline chips and the Sources list agree.
// If the text contains no in-range markers at all (some models cite without
// markers), fall back to showing the full original list unrenumbered.
export function remapCitations(
  texts: string[],
  citations: SourceCitation[]
): { ordered: SourceCitation[]; renumber: Map<number, number> } {
  const renumber = new Map<number, number>()
  const ordered: SourceCitation[] = []
  const re = /\[(\d{1,2})\]/g
  for (const text of texts) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const idx = Number(m[1])
      if (idx < 1 || idx > citations.length || renumber.has(idx)) continue
      renumber.set(idx, ordered.length + 1)
      ordered.push(citations[idx - 1])
    }
  }
  if (ordered.length === 0) return { ordered: citations, renumber }
  return { ordered, renumber }
}
