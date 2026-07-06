import type { Project } from '@shared/types'

type ConvoLike = { id: string; projectId: string | null; projectLabel: string; updatedAt: number }

export type SidebarGroup = (
  | { kind: 'project'; projectId: string; label: string }
  | { kind: 'folder'; label: string }
) & { convoIds: string[] }

// Project groups first (projects sorted by updatedAt desc, each shown even when
// empty), then the existing folder-basename grouping for unassigned
// conversations (preserving convoOrder within each). Feeds E3's "Group By".
export function groupConversations(
  order: string[],
  convos: Record<string, ConvoLike | undefined>,
  projects: Project[]
): SidebarGroup[] {
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
    if (convo.projectId && projectGroups.has(convo.projectId)) {
      projectGroups.get(convo.projectId)!.convoIds.push(id)
      continue
    }
    const existing = folderGroups.find((g) => g.label === convo.projectLabel)
    if (existing) existing.convoIds.push(id)
    else folderGroups.push({ kind: 'folder', label: convo.projectLabel, convoIds: [id] })
  }
  return [...groups, ...folderGroups]
}
