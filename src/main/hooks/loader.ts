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
import { statSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import type { HookRecord } from '../../shared/types'
import { capMap } from '../agentsDir/lruCap'
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

const HOOKS_FILE_CACHE_CAP = 512

interface HookFileCacheEntry {
  mtimeMs: number
  root: string | undefined
  // Pre-consent records, parsed once per (path, mtime, root). Immutable for
  // the lifetime of this entry.
  records: Omit<HookRecord, 'consented'>[]
  // `consented`/`mapped` below are a secondary, best-effort cache layer over
  // `records`: `consented` is ALWAYS recomputed fresh via isHookActive on
  // every single call to loadFrom, cache hit or miss -- see the isHookActive
  // call in loadFrom below, which is unconditional -- so toggling a hook's
  // enable/consent state via setHookActive/bearcode:hooks:setActive takes
  // effect on the very next call with no cache invalidation required. We
  // only reuse the previous call's `mapped` HookRecord objects (rather than
  // reallocating) when the freshly-recomputed `consented` flags are
  // bit-for-bit identical to the ones that produced `mapped` last time --
  // this gives callers stable object identity across truly-unchanged calls
  // (see loader.test.ts's "returns the same HookRecord object..." test)
  // without ever trusting a stale consent value.
  consented: boolean[]
  mapped: HookRecord[]
}
const hookFileCache = new Map<string, HookFileCacheEntry>()

function sameBooleans(a: boolean[], b: boolean[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function loadFrom(
  path: string,
  scope: 'global' | 'project' | 'plugin',
  source: string,
  projectPath: string | null,
  root?: string
): HookRecord[] {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    // Missing/unreadable: drop any stale entry so a file later re-created at
    // this same path can never resurrect a coincidentally-matching cache hit.
    hookFileCache.delete(path)
    return []
  }

  const cached = hookFileCache.get(path)
  let records: Omit<HookRecord, 'consented'>[]
  let priorConsented: boolean[] | undefined
  let priorMapped: HookRecord[] | undefined
  if (cached && cached.mtimeMs === mtimeMs && cached.root === root) {
    records = cached.records
    priorConsented = cached.consented
    priorMapped = cached.mapped
  } else {
    const read = readFileCapped(path, MAX_HOOKS_READ_BYTES, root)
    if (!read) {
      hookFileCache.delete(path)
      return []
    }
    records = parseHooksJson(read.text, scope, source)
  }

  // Always live -- see the HookFileCacheEntry doc comment above. Runs on
  // every call, cache hit or miss; never gated behind the mtime check above.
  const consented = records.map((rec) => isHookActive(rec, projectPath))
  const mapped =
    priorMapped && priorConsented && sameBooleans(priorConsented, consented)
      ? priorMapped
      : records.map((rec, i) => ({ ...rec, consented: consented[i] }))

  capMap(hookFileCache, path, { mtimeMs, root, records, consented, mapped }, HOOKS_FILE_CACHE_CAP)
  return mapped
}

export function loadHooks(projectPath: string | null, opts?: { trusted?: boolean }): HookRecord[] {
  const trusted = opts?.trusted ?? false
  const out: HookRecord[] = []

  out.push(...loadFrom(globalHooksPath(), 'global', 'global', projectPath))

  if (trusted && projectPath) {
    out.push(
      ...loadFrom(projectHooksPath(projectPath), 'project', projectPath, projectPath, projectPath)
    )
  }

  const { hookFiles } = enumeratePluginIngredients(projectPath, { trusted })
  for (const f of hookFiles) {
    // Same project-scope-plugin lexical check as agentsDir/index.ts's
    // rule/skill fold-in (see that file for the fuller rationale). Unlike
    // rules/skills, enumeratePluginIngredients builds hookFiles from a
    // bare existsSync check (plugins/index.ts, no manifest-layer content
    // validation upstream) -- this root check is the ONLY containment for
    // a project-scope plugin's hooks.json, not defense-in-depth.
    const root = projectPath && f.path.startsWith(projectPath + sep) ? projectPath : undefined
    out.push(...loadFrom(f.path, 'plugin', f.pluginName, projectPath, root))
  }

  return out
}
