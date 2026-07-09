type ConvoLike = {
  id: string
  projectPath: string | null
  projectLabel: string
  title: string
  updatedAt: number
  createdAt: number
  pinned: boolean
  archived: boolean
  runState: string
  environment: 'local' | 'worktree'
  worktrees: { branch: string }[]
}

// F9 (folder = project): every distinct workspace folder is a project group,
// keyed by its full path (basename collisions across different paths stay
// separate). A null path is the "No folder" group. Display color/icon/name come
// from the folder-settings row, looked up by path in the Sidebar.
// F3: 'environment' groups by local/worktree; 'status' groups by run-state
// bucket (Active/Idle/Error), computed via `statusBucket`.
export type SidebarGroup = (
  | { kind: 'folder'; path: string | null; label: string }
  | { kind: 'environment'; env: 'local' | 'worktree'; label: string }
  | { kind: 'status'; bucket: 'active' | 'idle' | 'error'; label: string }
  | { kind: 'all' }
) & { convoIds: string[] }

export type GroupOpts = {
  groupBy: 'project' | 'environment' | 'status' | 'none'
  sort: 'updated' | 'alpha' | 'created'
  showArchived: boolean
}

// F3: maps a conversation's run state to its sidebar status bucket.
export function statusBucket(runState: string): 'active' | 'idle' | 'error' {
  if (runState === 'running' || runState === 'awaiting-approval') return 'active'
  if (runState === 'error') return 'error'
  return 'idle'
}

const DEFAULT_OPTS: GroupOpts = { groupBy: 'project', sort: 'updated', showArchived: false }

function sortIds(
  ids: string[],
  convos: Record<string, ConvoLike | undefined>,
  sort: GroupOpts['sort']
): string[] {
  const withConvo = ids.map((id) => convos[id]).filter((c): c is ConvoLike => c != null)
  const sorted = [...withConvo].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (sort === 'alpha') return a.title.localeCompare(b.title)
    if (sort === 'created') return b.createdAt - a.createdAt
    return b.updatedAt - a.updatedAt
  })
  return sorted.map((c) => c.id)
}

// Group + sort conversations for the sidebar. groupBy 'none' -> one headerless
// 'all' group. groupBy 'project' -> one folder group per distinct projectPath,
// in first-appearance order over `order` (which is recency desc, so the folder
// touched most recently floats up). `sort` orders conversations WITHIN a group.
export function groupConversations(
  order: string[],
  convos: Record<string, ConvoLike | undefined>,
  opts: GroupOpts = DEFAULT_OPTS
): SidebarGroup[] {
  const visible = (id: string): boolean =>
    convos[id] != null && (opts.showArchived || !convos[id]!.archived)

  if (opts.groupBy === 'none') {
    const ids = order.filter(visible)
    return [{ kind: 'all', convoIds: sortIds(ids, convos, opts.sort) }]
  }

  if (opts.groupBy === 'status') {
    const order3: ('active' | 'idle' | 'error')[] = ['active', 'idle', 'error']
    const labels = { active: 'Active', idle: 'Idle', error: 'Error' } as const
    const buckets = new Map<string, string[]>()
    for (const id of order) {
      const c = convos[id]
      if (!c || !visible(id)) continue
      const b = statusBucket(c.runState)
      ;(buckets.get(b) ?? buckets.set(b, []).get(b)!).push(id)
    }
    return order3
      .filter((b) => buckets.has(b))
      .map((b) => ({
        kind: 'status' as const,
        bucket: b,
        label: labels[b],
        convoIds: sortIds(buckets.get(b)!, convos, opts.sort)
      }))
  }

  if (opts.groupBy === 'environment') {
    const order2: ('worktree' | 'local')[] = ['worktree', 'local']
    const labels = { local: 'Local', worktree: 'Worktree' } as const
    const buckets = new Map<string, string[]>()
    for (const id of order) {
      const c = convos[id]
      if (!c || !visible(id)) continue
      ;(buckets.get(c.environment) ?? buckets.set(c.environment, []).get(c.environment)!).push(id)
    }
    return order2
      .filter((e) => buckets.has(e))
      .map((e) => ({
        kind: 'environment' as const,
        env: e,
        label: labels[e],
        convoIds: sortIds(buckets.get(e)!, convos, opts.sort)
      }))
  }

  // Key by path directly; the null ("No folder") path is its own Map key, so it
  // can never collide with a real workspace path (a sentinel string could).
  const groups = new Map<string | null, SidebarGroup & { kind: 'folder' }>()
  for (const id of order) {
    const convo = convos[id]
    if (!convo || !visible(id)) continue
    const existing = groups.get(convo.projectPath)
    if (existing) existing.convoIds.push(id)
    else {
      groups.set(convo.projectPath, {
        kind: 'folder',
        path: convo.projectPath,
        label: convo.projectLabel,
        convoIds: [id]
      })
    }
  }
  const all = [...groups.values()]
  for (const g of all) g.convoIds = sortIds(g.convoIds, convos, opts.sort)
  return all
}
