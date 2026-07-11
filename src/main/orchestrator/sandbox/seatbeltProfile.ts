import type { SandboxPolicy } from './types'

// SBPL is last-match-wins: (deny default) first, broad allows next, then the
// narrow read denies AFTER (allow file-read*) so they win. sandbox-exec is
// macOS-only; the caller platform-guards before ever building a profile.
function quote(path: string): string {
  return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = ['(version 1)', '(deny default)']
  // Minimum a login zsh needs to locate + exec its own binaries.
  lines.push(
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow signal (target self))'
  )
  // Broad read, then subtract the secret paths (last-match-wins).
  lines.push('(allow file-read*)')
  for (const p of policy.readDenyPaths) {
    lines.push(`(deny file-read* (subpath ${quote(p)}))`)
  }
  // Writes only under the workspace/worktree + temp roots (deny-default covers
  // everywhere else).
  for (const root of policy.writeRoots) {
    lines.push(`(allow file-write* (subpath ${quote(root)}))`)
  }
  lines.push(policy.allowNetwork ? '(allow network*)' : '(deny network*)')
  return lines.join('\n') + '\n'
}
