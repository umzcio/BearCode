// Antigravity-style attachment type badge: a short uppercase label + a color
// class, derived from the file's name/mime (not just its lane `kind`, since
// 'office' covers both docx and xlsx which get different colors). Pure/no
// deps so it's trivial to unit-test; unknown extensions fall back to a
// generic muted label rather than throwing.
export interface AttachmentBadge {
  label: string
  colorClass: string
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i < 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

export function attachmentBadge(name: string, mime: string): AttachmentBadge {
  const ext = extOf(name)
  const m = mime.toLowerCase()

  if (ext === 'pdf' || m === 'application/pdf') {
    return { label: 'PDF', colorClass: 'badge-pdf' }
  }
  if (ext === 'docx' || m.includes('wordprocessingml')) {
    return { label: 'DOCX', colorClass: 'badge-docx' }
  }
  if (ext === 'doc' || m === 'application/msword') {
    return { label: 'DOC', colorClass: 'badge-docx' }
  }
  if (ext === 'xlsx' || m.includes('spreadsheetml')) {
    return { label: 'XLSX', colorClass: 'badge-xlsx' }
  }
  if (ext === 'xls' || m === 'application/vnd.ms-excel') {
    return { label: 'XLS', colorClass: 'badge-xlsx' }
  }
  if (ext === 'csv') return { label: 'CSV', colorClass: 'badge-muted' }
  if (ext === 'json') return { label: 'JSON', colorClass: 'badge-muted' }
  if (ext === 'md' || ext === 'markdown') return { label: 'MD', colorClass: 'badge-muted' }
  if (ext === 'html' || ext === 'htm') return { label: 'HTML', colorClass: 'badge-muted' }
  if (ext === 'txt' || m.startsWith('text/')) return { label: 'TXT', colorClass: 'badge-muted' }
  if (ext) return { label: ext.slice(0, 4).toUpperCase(), colorClass: 'badge-muted' }
  return { label: 'FILE', colorClass: 'badge-muted' }
}
