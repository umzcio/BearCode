const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// Preview lane by file extension (the file's real path — we control it).
export function previewClassify(
  path: string
): { kind: 'image' | 'pdf' | 'office' | 'html' | 'text'; mime?: string } {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return { kind: 'image' }
  if (ext === 'html' || ext === 'htm') return { kind: 'html' }
  if (ext === 'pdf') return { kind: 'pdf' }
  if (ext === 'docx') return { kind: 'office', mime: DOCX }
  if (ext === 'xlsx') return { kind: 'office', mime: XLSX }
  return { kind: 'text' }
}
