export function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = sizeBytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024
    unit = units[i]
  }
  const displayed = (value >= 10 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/, '')
  return `${displayed} ${unit}`
}
