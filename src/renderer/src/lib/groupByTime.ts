// Pure time-bucketing for the History browse view (F1 Conversation History).
// `now` is passed in explicitly (never Date.now()) so the helper is
// deterministic and unit-testable. Buckets are calendar-based off local
// midnight of `now`, in fixed order; empty buckets are omitted.

export type TimeBucket = 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older'

const BUCKET_ORDER: TimeBucket[] = ['Today', 'Yesterday', 'This week', 'This month', 'Older']

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function bucketFor(updatedAt: number, now: number): TimeBucket {
  const todayStart = startOfDay(now)
  const dayMs = 24 * 60 * 60 * 1000
  const itemDayStart = startOfDay(updatedAt)
  const daysAgo = Math.round((todayStart - itemDayStart) / dayMs)

  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo <= 7) return 'This week'
  if (daysAgo <= 31) return 'This month'
  return 'Older'
}

export function groupByTime<T extends { updatedAt: number }>(
  items: T[],
  now: number
): { bucket: TimeBucket; items: T[] }[] {
  const byBucket = new Map<TimeBucket, T[]>()

  for (const item of items) {
    const bucket = bucketFor(item.updatedAt, now)
    const list = byBucket.get(bucket)
    if (list) list.push(item)
    else byBucket.set(bucket, [item])
  }

  const result: { bucket: TimeBucket; items: T[] }[] = []
  for (const bucket of BUCKET_ORDER) {
    const list = byBucket.get(bucket)
    if (list && list.length > 0) {
      result.push({ bucket, items: [...list].sort((a, b) => b.updatedAt - a.updatedAt) })
    }
  }
  return result
}
