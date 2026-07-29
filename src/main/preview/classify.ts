import { extensionForPath, languageForPath } from '../../shared/fileClassification'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export type PreviewKind =
  'image' | 'svg' | 'pdf' | 'docx' | 'xlsx' | 'markdown' | 'csv' | 'json' | 'code' | 'html' | 'text'

export function previewClassify(path: string): { kind: PreviewKind; language?: string } {
  const ext = extensionForPath(path)
  if (IMAGE_EXT.has(ext)) return { kind: 'image' }
  if (ext === 'svg') return { kind: 'svg' }
  if (ext === 'pdf') return { kind: 'pdf' }
  if (ext === 'docx') return { kind: 'docx' }
  if (ext === 'xlsx') return { kind: 'xlsx' }
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown' }
  if (ext === 'csv') return { kind: 'csv' }
  if (ext === 'json') return { kind: 'json' }
  if (ext === 'html' || ext === 'htm') return { kind: 'html' }
  const language = languageForPath(path)
  if (language !== 'plaintext') return { kind: 'code', language }
  return { kind: 'text' }
}
