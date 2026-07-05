import type { PermissionRule } from '../../shared/types'

// Built-in deny rules, seeded in code (never the DB) so upgrades can revise them
// and a user cannot delete the guardrails. All are deny + source 'builtin'; a
// user allow can never override them (evaluateCommand/evaluateEdit check deny
// first). The command match is a trailing '*' prefix or exact string -- see
// matchesCommand. The edit match is a workspace-relative path glob -- see
// matchesEditPath. Deliberately conservative: catch the classic foot-guns, not
// every risky command or path (the approval card + modes still gate everything
// else for commands; edits have no allow tier by design, see evaluateEdit).
export const BUILTIN_RULES: PermissionRule[] = [
  {
    id: 'builtin:rm-rf-root',
    scope: 'global',
    action: 'command',
    match: 'rm -rf /',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:rm-rf-home',
    scope: 'global',
    action: 'command',
    match: 'rm -rf ~',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:rm-fr-root',
    scope: 'global',
    action: 'command',
    match: 'rm -fr /',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:curl-pipe-sh',
    scope: 'global',
    action: 'command',
    match: 'curl * | sh',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:curl-pipe-bash',
    scope: 'global',
    action: 'command',
    match: 'curl * | bash',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:wget-pipe-sh',
    scope: 'global',
    action: 'command',
    match: 'wget * | sh',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:wget-pipe-bash',
    scope: 'global',
    action: 'command',
    match: 'wget * | bash',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:fork-bomb',
    scope: 'global',
    action: 'command',
    match: ':(){ :|:& };:',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:edit-git-dir',
    scope: 'global',
    action: 'edit',
    match: '.git/**',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:edit-env-root',
    scope: 'global',
    action: 'edit',
    match: '.env',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:edit-env-variants',
    scope: 'global',
    action: 'edit',
    match: '.env.*',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:edit-env-nested',
    scope: 'global',
    action: 'edit',
    match: '**/.env',
    effect: 'deny',
    source: 'builtin'
  },
  {
    id: 'builtin:edit-env-nested-variants',
    scope: 'global',
    action: 'edit',
    match: '**/.env.*',
    effect: 'deny',
    source: 'builtin'
  }
]
