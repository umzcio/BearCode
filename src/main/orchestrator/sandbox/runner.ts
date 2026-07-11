import { execFileSync } from 'child_process'
import { buildSeatbeltProfile } from './seatbeltProfile'
import { scrubEnv } from './scrubEnv'
import type { SandboxPlan, SandboxPolicy, SandboxRunner } from './types'

// Seatbelt (sandbox-exec) backend. available() gates on macOS AND the binary
// being resolvable; wrap() renders the SBPL inline (-p) and re-uses the SAME
// login-interactive zsh the uncaged path uses, only inside the box + scrubbed env.
export class SeatbeltRunner implements SandboxRunner {
  // sandbox-exec presence cannot change mid-session; probe once. (audit M-12)
  private availableMemo: boolean | undefined

  available(): boolean {
    if (this.availableMemo !== undefined) return this.availableMemo
    this.availableMemo = this.probe()
    return this.availableMemo
  }

  private probe(): boolean {
    if (process.platform !== 'darwin') return false
    try {
      execFileSync('/usr/bin/which', ['sandbox-exec'], { stdio: ['ignore', 'pipe', 'ignore'] })
      return true
    } catch {
      return false
    }
  }

  wrap(command: string, _cwd: string, policy: SandboxPolicy): SandboxPlan {
    const profile = buildSeatbeltProfile(policy)
    return {
      file: 'sandbox-exec',
      args: ['-p', profile, '/bin/zsh', '-lc', command],
      env: scrubEnv(process.env)
    }
  }
}

export const seatbeltRunner: SandboxRunner = new SeatbeltRunner()
