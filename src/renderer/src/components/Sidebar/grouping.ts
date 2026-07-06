import type { Project } from '@shared/types'

type ConvoLike = {
  id: string
  projectId: string | null
  projectLabel: string
  title: string
  updatedAt: number
  createdAt: number
  pinned: boolean
  archived: boolean
}

export type SidebarGroup = (
  | { kind: 'project'; projectId: string; label: string }
  | { kind: 'folder'; label: string }
  | { kind: 'all' }
) & { convoIds: string[] }

export type GroupOpts = {
  groupBy: 'project' | 'none'
  sort: 'updated' | 'alpha' | 'created'
  showArchived: boolean
}

const DEFAULT_OPTS: GroupOpts = { groupBy: 'project', sort: 'updated', showArchived: false }

function sortIds(ids: string[], convos: Record<string, ConvoLike | undefined>, sort: GroupOpts['sort']): string[] {
  const withConvo = ids.map((id) => convos[id]).filter((c): c is ConvoLike => c != null)
  const sorted = [...withConvo].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (sort === 'alpha') return a.title.localeCompare(b.title)
    if (sort === 'created') return b.createdAt - a.createdAt
    return b.updatedAt - a.updatedAt
  })
  return sorted.map((c) => c.id)
}

// Group + sort conversations for the sidebar. groupBy 'none' → one headerless
// 'all' group; 'project' → project groups (updatedAt desc, empty shown) then
// folder-basename groups for unassigned. `sort` orders conversations WITHIN each
// group. Default opts reproduce the pre-E3 behavior.
export function groupConversations(
  order: string[],
  convos: Record<string, ConvoLike | undefined>,
  projects: Project[],
  opts: GroupOpts = DEFAULT_OPTS
): SidebarGroup[] {
  if (opts.groupBy === 'none') {
    const ids = order.filter((id) => convos[id] != null && (opts.showArchived || !convos[id]!.archived))
    return [{ kind: 'all', convoIds: sortIds(ids, convos, opts.sort) }]
  }
  const groups: SidebarGroup[] = []
  const sortedProjects = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)
  const projectGroups = new Map<string, SidebarGroup>()
  for (const p of sortedProjects) {
    const g: SidebarGroup = { kind: 'project', projectId: p.id, label: p.name, convoIds: [] }
    projectGroups.set(p.id, g)
    groups.push(g)
  }
  const folderGroups: SidebarGroup[] = []
  for (const id of order) {
    const convo = convos[id]
    if (!convo) continue
    if (!opts.showArchived && convo.archived) continue
    if (convo.projectId && projectGroups.has(convo.projectId)) {
      projectGroups.get(convo.projectId)!.convoIds.push(id)
      continue
    }
    const existing = folderGroups.find((g) => g.kind === 'folder' && g.label === convo.projectLabel)
    if (existing) existing.convoIds.push(id)
    else folderGroups.push({ kind: 'folder', label: convo.projectLabel, convoIds: [id] })
  }
  const all = [...groups, ...folderGroups]
  for (const g of all) g.convoIds = sortIds(g.convoIds, convos, opts.sort)
  return all
}
