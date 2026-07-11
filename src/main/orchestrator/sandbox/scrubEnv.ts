// Allowlist keep-set (exact names) + LC_* prefix. Everything else is dropped
// (default-deny). A denylist of secret-shaped patterns runs AFTER the allowlist
// as belt-and-suspenders in case a keep-name is ever widened.
const KEEP = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TERM_PROGRAM',
  'LANG',
  'TMPDIR',
  'TZ',
  'PWD'
])
const DENY = [
  /^AWS_/,
  /_TOKEN$/,
  /_KEY$/,
  /_SECRET$/,
  /^GITHUB_/,
  /^GH_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^GOOGLE_/
]

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    const keep = KEEP.has(k) || k.startsWith('LC_')
    if (!keep) continue
    if (DENY.some((re) => re.test(k))) continue
    out[k] = v
  }
  return out
}
