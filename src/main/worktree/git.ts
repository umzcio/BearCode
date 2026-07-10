import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

// `env` (optional) is merged over the parent process env for this invocation
// only — used by the integrations layer to inject GIT_ASKPASS credentials for
// private HTTPS remotes (see integrations/gitCredentials.ts). Never written to
// disk config; scoped to the single child process.
export function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env
    }
    execFile('git', args, options, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err) => resolve(!err))
  })
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

// A repo is the project folder itself (if it is a repo) plus any IMMEDIATE
// subdirectory that is a repo. Deeper/nested repos + submodules are ignored
// (locked scope). Returns absolute paths.
export function discoverRepos(projectPath: string): string[] {
  const repos: string[] = []
  if (isGitRepo(projectPath)) repos.push(projectPath)
  let entries: import('fs').Dirent[] = []
  try {
    entries = readdirSync(projectPath, { withFileTypes: true })
  } catch {
    return repos
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue
    const child = join(projectPath, e.name)
    if (isGitRepo(child)) repos.push(child)
  }
  return repos
}
