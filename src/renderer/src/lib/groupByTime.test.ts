import { describe, it, expect } from 'vitest'
import { groupByTime } from './groupByTime'

const DAY = 24 * 60 * 60 * 1000

describe('groupByTime', () => {
  // Fixed "now": 2026-07-07T12:00:00 local time.
  const now = new Date(2026, 6, 7, 12, 0, 0).getTime()

  it('buckets items into Today / Yesterday / This week / This month / Older, newest-first, empty buckets omitted', () => {
    const today = { id: 'today', updatedAt: new Date(2026, 6, 7, 9, 0, 0).getTime() }
    const todayLater = { id: 'today-later', updatedAt: new Date(2026, 6, 7, 11, 0, 0).getTime() }
    const yesterday = { id: 'yesterday', updatedAt: new Date(2026, 6, 6, 10, 0, 0).getTime() }
    const threeDaysAgo = { id: 'three-days', updatedAt: now - 3 * DAY }
    const twentyDaysAgo = { id: 'twenty-days', updatedAt: now - 20 * DAY }
    const twoHundredDaysAgo = { id: 'two-hundred-days', updatedAt: now - 200 * DAY }

    const result = groupByTime(
      [today, todayLater, yesterday, threeDaysAgo, twentyDaysAgo, twoHundredDaysAgo],
      now
    )

    expect(result.map((g) => g.bucket)).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'This month',
      'Older'
    ])

    expect(result[0].items.map((i) => i.id)).toEqual(['today-later', 'today'])
    expect(result[1].items.map((i) => i.id)).toEqual(['yesterday'])
    expect(result[2].items.map((i) => i.id)).toEqual(['three-days'])
    expect(result[3].items.map((i) => i.id)).toEqual(['twenty-days'])
    expect(result[4].items.map((i) => i.id)).toEqual(['two-hundred-days'])
  })

  it('omits empty buckets', () => {
    const today = { id: 'today', updatedAt: now - 60 * 1000 }
    const twoHundredDaysAgo = { id: 'two-hundred-days', updatedAt: now - 200 * DAY }
    const result = groupByTime([today, twoHundredDaysAgo], now)
    expect(result.map((g) => g.bucket)).toEqual(['Today', 'Older'])
  })

  it('returns an empty array for no items', () => {
    expect(groupByTime([], now)).toEqual([])
  })
})
