export function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return `${days}d`
}

// Timestamp shown on a message hover: clock time for today (e.g. "2:58 PM"),
// a relative day for the recent past ("yesterday", "3 days ago"), and a plain
// date for anything older ("Jul 3") -- matching Claude Code / Antigravity.
export function messageTimestamp(timestamp: number): string {
  const then = new Date(timestamp)
  const now = new Date()
  const sameDay = then.toDateString() === now.toDateString()
  if (sameDay) {
    return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()
  const daysAgo = Math.round((startOfToday - startOfThen) / 86400000)
  if (daysAgo === 1) return 'yesterday'
  if (daysAgo < 7) return `${daysAgo} days ago`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
