// Process-neutral path facts shared by preview classification and Monaco views.
// Keep this vocabulary free of Electron, renderer, and content-inspection concerns.
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
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
  swift: 'swift',
  html: 'html',
  htm: 'html',
  json: 'json',
  md: 'markdown'
})

const RENDERED_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'pdf',
  'docx',
  'xlsx'
])

export function extensionForPath(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path
  const dot = fileName.lastIndexOf('.')
  return dot <= 0 || dot === fileName.length - 1 ? '' : fileName.slice(dot + 1).toLowerCase()
}

export function languageForPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[extensionForPath(path)] ?? 'plaintext'
}

export function defaultsToRenderedPreview(path: string): boolean {
  return RENDERED_PREVIEW_EXTENSIONS.has(extensionForPath(path))
}
