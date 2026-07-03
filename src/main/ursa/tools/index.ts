// The v1 read-only tool set. Every path is resolved against the
// conversation's projectPath and verified to stay inside it after symlink
// resolution: no .. escapes, no absolute paths outside the workspace.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'path'
import { z } from 'zod'
import { rgPath } from '@vscode/ripgrep'
import type { ToolName } from '../../../shared/types'

const execFileAsync = promisify(execFile)

export interface ToolContext {
  projectPath: string
}

export interface UrsaTool {
  description: string
  // z.ZodType with a broad input; each execute narrows via parse
  inputSchema: z.ZodType
  execute(input: unknown, ctx: ToolContext): Promise<string>
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
