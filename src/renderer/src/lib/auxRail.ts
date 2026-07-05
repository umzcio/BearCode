import type { ArtifactType, Event } from '@shared/types'

export type ArtifactEvent = Extract<Event, { type: 'artifact' }>
export type FileDiffEvent = Extract<Event, { type: 'file_diff' }>

export type RailEntry =
  { kind: 'artifact'; event: ArtifactEvent } | { kind: 'diff'; event: FileDiffEvent }

// The unified Auxiliary Pane rail (design 3.6, Ba4): every artifact event
// plus one virtual "Changes" entry per diff group, newest first. The diff
// entries are DERIVED from the existing file_diff events over the existing
// diffs table -- zero data migration (design 3.4). Superseded artifacts
// collapse out of the rail: supersession is the only persisted "same chain"
// signal, so the rail shows each live deliverable once and the viewer's
// version chips (versionsOfType) own the history. Non-superseded same-type
// artifacts are independent deliverables and each keep their own entry.
export function deriveRailEntries(events: Event[]): RailEntry[] {
  const entries: RailEntry[] = []
  for (const e of events) {
    if (e.type === 'artifact' && e.status !== 'superseded') {
      entries.push({ kind: 'artifact', event: e })
    } else if (e.type === 'file_diff') {
      entries.push({ kind: 'diff', event: e })
    }
  }
  return entries.reverse()
}

// All versions of one artifact type, oldest first, superseded included --
// that is the point (design section 7: superseded plans viewable).
export function versionsOfType(events: Event[], type: ArtifactType): ArtifactEvent[] {
  return events
    .filter((e): e is ArtifactEvent => e.type === 'artifact' && e.artifactType === type)
    .sort((a, b) => a.version - b.version)
}
