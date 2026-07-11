import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, existsSync, rmSync, realpathSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { buildSeatbeltProfile } from './seatbeltProfile'
import type { SandboxPolicy } from './types'

const isMac = process.platform === 'darwin'

// Run `command` under sandbox-exec with the given policy; return {code, out}.
function runSandboxed(command: string, policy: SandboxPolicy): { code: number; out: string } {
  const profile = buildSeatbeltProfile(policy)
  const r = spawnSync('sandbox-exec', ['-p', profile, '/bin/zsh', '-lc', command], {
    encoding: 'utf8'
  })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe.skipIf(!isMac)('Seatbelt integration', () => {
  let work: string
  let outside: string
  beforeAll(() => {
    // SBPL subpath rules match against the CANONICAL path the kernel resolves
    // requests to, so both roots here must be realpath'd (per the SandboxPolicy
    // contract in types.ts). `outside` is deliberately placed under $HOME
    // rather than the system tmpdir: the policy's write roots broadly allow
    // '/private/tmp' and '/private/var/folders' (real tools need tmpdir
    // scratch space), and os.tmpdir() resolves under /private/var/folders —
    // so a tmpdir-based "outside" dir would actually be inside an allowed
    // write root and could never demonstrate a block.
    work = realpathSync(mkdtempSync(join(tmpdir(), 'bearcode-sbx-work-')))
    outside = realpathSync(mkdtempSync(join(homedir(), '.bearcode-sbx-out-')))
  })

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const policy = (allowNetwork: boolean, extraDeny: string[] = []): SandboxPolicy => ({
    writeRoots: [work, '/private/tmp', '/private/var/folders'],
    readDenyPaths: extraDeny,
    allowNetwork
  })

  it('allows a write INSIDE a write root', () => {
    const target = join(work, 'ok.txt')
    const { code } = runSandboxed(`echo hi > "${target}"`, policy(false))
    expect(code).toBe(0)
    expect(existsSync(target)).toBe(true)
  })

  it('blocks a write OUTSIDE every write root', () => {
    const target = join(outside, 'blocked.txt')
    const { code } = runSandboxed(`echo hi > "${target}"`, policy(false))
    expect(code).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('blocks network when allowNetwork is false', () => {
    // A dial that would succeed uncaged; sandboxed it must fail fast.
    const { code } = runSandboxed(
      'curl -sS --max-time 5 http://example.com > /dev/null',
      policy(false)
    )
    expect(code).not.toBe(0)
  })

  it('denies reading a readDeny path', () => {
    const secret = join(outside, 'secret.txt')
    spawnSync('/bin/zsh', ['-lc', `echo topsecret > "${secret}"`])
    const { code } = runSandboxed(`cat "${secret}"`, policy(false, [outside]))
    expect(code).not.toBe(0)
  })

  it('can still read normal files (broad file-read*)', () => {
    const { code, out } = runSandboxed(
      'echo $PATH && /bin/ls /usr/bin > /dev/null && echo READOK',
      policy(false)
    )
    expect(code).toBe(0)
    expect(out).toContain('READOK')
  })
})
