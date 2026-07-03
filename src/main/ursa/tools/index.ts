// The v1 read-only tool set. Every path is resolved against the
// conversation's projectPath and verified to stay inside it after symlink
// resolution: no .. escapes, no absolute paths outside the workspace.
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'path'
import { z } from 'zod'
import { rgPath } from '@vscode/ripgrep'
import type { ToolName } from '../../../shared/types'

const execFileAsync = promisify(execFile)

export interface StagedStats {
  path: string
  status: 'created' | 'modified' | 'deleted'
  additions: number
  deletions: number
}

export interface ToolContext {
  projectPath: string
  // Staging hook provided by the run loop: write tools never touch disk.
  // Returns the staged change's line counts for the step row display.
  stage?(absPath: string, beforeText: string, afterText: string): StagedStats
}

export interface UrsaTool {
  description: string
  // z.ZodType with a broad input; each execute narrows via parse
  inputSchema: z.ZodType
  // run_command needs approval before execution (spec 6.2)
  requiresApproval?: boolean
  execute(
    input: unknown,
    ctx: ToolContext
  ): Promise<string | { output: string; exitCode?: number; stats?: StagedStats }>
}

function jailPath(projectPath: string, p: string | undefined): string {
  const root = realpathSync(projectPath)
  const raw = !p || p === '.' ? root : isAbsolute(p) ? p : resolve(root, p)
  // Resolve symlinks on the nearest existing ancestor so links cannot
  // smuggle reads outside the workspace.
  let probe = raw
  let suffix = ''
  for (;;) {
    try {
      probe = realpathSync(probe)
      break
    } catch {
      suffix = sep + basename(probe) + suffix
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  const real = probe + suffix
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`Path is outside the workspace: ${p}`)
  }
  return real
}

async function rg(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(rgPath, args, {
      cwd,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024
    })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    if (e.code === 1) return { stdout: e.stdout ?? '', code: 1 } // no matches
    throw err
  }
}

const listDirSchema = z.object({
  path: z.string().optional().describe('Directory relative to the workspace root. Default: root.'),
  depth: z.number().int().min(1).max(10).optional().describe('Max depth, default 3.')
})

const readFileSchema = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  offset: z.number().int().min(1).optional().describe('1-based first line to read.'),
  limit: z.number().int().min(1).optional().describe('Max lines to return, default 2000.')
})

const searchSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for.'),
  glob: z.string().optional().describe('Limit to files matching this glob, e.g. "*.ts".')
})

export const TOOLS: Partial<Record<ToolName, UrsaTool>> = {
  list_dir: {
    description:
      'List files under a directory in the workspace (respects .gitignore). Returns relative paths.',
    inputSchema: listDirSchema,
    async execute(input, ctx) {
      const { path, depth } = listDirSchema.parse(input)
      const dir = jailPath(ctx.projectPath, path)
      const { stdout } = await rg(
        ['--files', '--hidden', '-g', '!.git', '--max-depth', String(depth ?? 3), '--sort', 'path'],
        dir
      )
      const lines = stdout.split('\n').filter(Boolean)
      const capped = lines.slice(0, 500)
      const notice = lines.length > 500 ? `\n… ${lines.length - 500} more files not shown` : ''
      return capped.length ? capped.join('\n') + notice : '(no files found)'
    }
  },
  read_file: {
    description: 'Read a text file from the workspace. Large files are truncated with a notice.',
    inputSchema: readFileSchema,
    async execute(input, ctx) {
      const { path, offset, limit } = readFileSchema.parse(input)
      const file = jailPath(ctx.projectPath, path)
      const all = readFileSync(file, 'utf8').split('\n')
      const start = (offset ?? 1) - 1
      const max = limit ?? 2000
      const slice = all.slice(start, start + max)
      const notice =
        start + slice.length < all.length
          ? `\n… truncated: showing lines ${start + 1}-${start + slice.length} of ${all.length}`
          : ''
      return slice.join('\n') + notice
    }
  },
  search_files: {
    description: 'Search file contents in the workspace with a regex (ripgrep). Max 200 matches.',
    inputSchema: searchSchema,
    async execute(input, ctx) {
      const { pattern, glob } = searchSchema.parse(input)
      const args = ['-n', '--no-heading', '--max-columns', '250', '-e', pattern]
      if (glob) args.push('-g', glob)
      args.push('.')
      const { stdout, code } = await rg(args, jailPath(ctx.projectPath, undefined))
      if (code === 1) return 'No matches found.'
      const lines = stdout.split('\n').filter(Boolean)
      const capped = lines.slice(0, 200)
      const notice = lines.length > 200 ? `\n… ${lines.length - 200} more matches not shown` : ''
      return capped.join('\n') + notice
    }
  }
}

const writeSchema = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  content: z.string().describe('Full new file content.')
})

const editSchema = z.object({
  path: z.string().describe('File path relative to the workspace root.'),
  old_str: z.string().describe('Exact text to replace. Must appear exactly once in the file.'),
  new_str: z.string().describe('Replacement text.')
})

const commandSchema = z.object({
  command: z.string().describe('Shell command to run in the workspace folder.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Timeout, default 60s.')
})

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, detached: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL') // kill the whole tree
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (out.length > 50000) out = out.slice(0, 50000) + '\n… output truncated'
      if (timedOut) out += `\n(command timed out after ${timeoutMs}ms and was killed)`
      resolvePromise({ output: out || '(no output)', exitCode: code ?? -1 })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ output: `Failed to start command: ${err.message}`, exitCode: -1 })
    })
  })
}

TOOLS.write_file = {
  description:
    'Write a file in the workspace. The change is staged as a diff for human review; it is not applied until the user accepts it.',
  inputSchema: writeSchema,
  async execute(input, ctx) {
    const { path, content } = writeSchema.parse(input)
    const abs = jailPath(ctx.projectPath, path)
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
    if (!ctx.stage) throw new Error('Staging unavailable')
    const stats = ctx.stage(abs, before, content)
    return {
      output: `Change staged for review: ${path}. The user must accept it before it is written to disk.`,
      stats
    }
  }
}

TOOLS.edit_file = {
  description:
    'Replace old_str (which must be unique in the file) with new_str. The change is staged as a diff for human review. Prefer this over rewriting whole files.',
  inputSchema: editSchema,
  async execute(input, ctx) {
    const { path, old_str, new_str } = editSchema.parse(input)
    const abs = jailPath(ctx.projectPath, path)
    if (!existsSync(abs)) throw new Error(`File not found: ${path}`)
    const before = readFileSync(abs, 'utf8')
    const count = before.split(old_str).length - 1
    if (count === 0) throw new Error(`old_str not found in ${path}`)
    if (count > 1) throw new Error(`old_str appears ${count} times in ${path}; it must be unique`)
    if (!ctx.stage) throw new Error('Staging unavailable')
    const stats = ctx.stage(abs, before, before.replace(old_str, new_str))
    return {
      output: `Change staged for review: ${path}. The user must accept it before it is written to disk.`,
      stats
    }
  }
}

TOOLS.run_command = {
  description:
    'Run a shell command in the workspace folder. Output is stdout+stderr combined. The user may need to approve the command first.',
  inputSchema: commandSchema,
  requiresApproval: true,
  async execute(input, ctx) {
    const { command, timeoutMs } = commandSchema.parse(input)
    return runCommand(command, jailPath(ctx.projectPath, undefined), timeoutMs ?? 60000)
  }
}
