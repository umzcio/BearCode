// Preview lane by file extension (the file's real path — we control it).
// LANG_BY_EXT duplicates (doesn't import — this is main; AuxiliaryPane's
// languageFor is renderer-side) the Monaco language-id mapping used elsewhere.
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  xml: 'xml',
  swift: 'swift'
}

const CODE_EXT = new Set(Object.keys(LANG_BY_EXT))

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export type PreviewKind =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'markdown'
  | 'csv'
  | 'json'
  | 'code'
  | 'html'
  | 'text'

export function previewClassify(path: string): { kind: PreviewKind; language?: string } {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (IMAGE_EXT.has(ext)) return { kind: 'image' }
  if (ext === 'svg') return { kind: 'svg' }
  if (ext === 'pdf') return { kind: 'pdf' }
  if (ext === 'docx') return { kind: 'docx' }
  if (ext === 'xlsx') return { kind: 'xlsx' }
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown' }
  if (ext === 'csv') return { kind: 'csv' }
  if (ext === 'json') return { kind: 'json' }
  if (ext === 'html' || ext === 'htm') return { kind: 'html' }
  if (CODE_EXT.has(ext)) return { kind: 'code', language: LANG_BY_EXT[ext] }
  return { kind: 'text' }
}
