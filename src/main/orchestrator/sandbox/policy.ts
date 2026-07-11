import { app } from 'electron'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { SandboxPolicy } from './types'

// Assemble the live policy for one command. Write roots: the command's cwd
// (workspace or worktree root, already realpath'd by worktreeCommandCwd) + the
// system temp dirs (build tools need scratch). Read-deny: the secret dirs the
// design enumerates (§5.2) + the app's own encrypted key vault. Paths are used
// verbatim; the SeatbeltRunner/buildSeatbeltProfile quote them.
export function buildSandboxPolicy(cwd: string, allowNetwork: boolean): SandboxPolicy {
  const home = homedir()
  const writeRoots = [cwd, tmpdir(), '/private/tmp', '/private/var/folders']
  const readDenyPaths = [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.config/gh'),
    join(home, '.config/gcloud'),
    join(home, '.gnupg'),
    join(home, '.bearcode'),
    join(app.getPath('userData'), 'keys.json')
  ]
  return { writeRoots, readDenyPaths, allowNetwork }
}
