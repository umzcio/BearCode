// Trust-gated hook loader (design 2026-07-11-hooks-arc-design.md §5.1). Reads
// global ~/.bearcode/agents/hooks.json (always -- user-authored, trusted),
// project <project>/.agents/hooks.json (only when the caller has already
// marked the workspace trusted -- secure default, same rule as
// loadMemory/enumeratePluginIngredients), and plugin hooks.json files
// surfaced by enumeratePluginIngredients (already enabled+trust-gated there).
// Each raw record is parsed by parseHooksJson (pure, bounded, never throws)
// then stamped with its live enable/consent state via isHookActive. A
// missing/unreadable/malformed source simply yields no records for that
// source -- loadHooks itself never throws.
import { homedir } from 'os'
import { join } from 'path'
import type { HookRecord } from '../../shared/types'
import { readFileCapped } from '../fsCapped'
import { enumeratePluginIngredients } from '../plugins'
import { parseHooksJson } from './parse'
import { isHookActive } from './state'

const MAX_HOOKS_READ_BYTES = 64 * 1024

function globalHooksPath(): string {
  return join(homedir(), '.bearcode', 'agents', 'hooks.json')
}

function projectHooksPath(projectPath: string): string {
  return join(projectPath, '.agents', 'hooks.json')
}

function loadFrom(
  path: string,
  scope: 'global' | 'project' | 'plugin',
  source: string,
  projectPath: string | null
): HookRecord[] {
  const read = readFileCapped(path, MAX_HOOKS_READ_BYTES)
  if (!read) return []
  return parseHooksJson(read.text, scope, source).map((rec) => ({
    ...rec,
    consented: isHookActive(rec, projectPath)
  }))
}

export function loadHooks(projectPath: string | null, opts?: { trusted?: boolean }): HookRecord[] {
  const trusted = opts?.trusted ?? false
  const out: HookRecord[] = []

  out.push(...loadFrom(globalHooksPath(), 'global', 'global', projectPath))

  if (trusted && projectPath) {
    out.push(...loadFrom(projectHooksPath(projectPath), 'project', projectPath, projectPath))
  }

  const { hookFiles } = enumeratePluginIngredients(projectPath, { trusted })
  for (const f of hookFiles) {
    out.push(...loadFrom(f.path, 'plugin', f.pluginName, projectPath))
  }

  return out
}
