// Plugin discovery + lifecycle. Scans global (~/.bearcode/agents/plugins) and
// project (<proj>/.agents/plugins) for plugin.json-marked dirs. Project
// plugins are TRUST-GATED (secure default: untrusted unless opts.trusted) —
// same rule as loadMemory/loadAgentsContent. All destructive ops path-jailed.
import { existsSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { PluginEntry } from '../../shared/types'
import { parsePluginDir } from './manifest'
import { isPluginEnabled, setPluginEnabled } from './state'

export function pluginsDir(scope: 'global' | 'project', projectPath: string | null): string {
  if (scope === 'global') return join(homedir(), '.bearcode', 'agents', 'plugins')
  if (!projectPath) throw new Error('A project must be open to address project-scope plugins.')
  return join(projectPath, '.agents', 'plugins')
}

function jailedPluginFolder(
  scope: 'global' | 'project',
  name: string,
  projectPath: string | null
): string {
  if (!COMMAND_NAME_PATTERN.test(name))
    throw new Error('Plugin name must be kebab-case (traversal rejected).')
  const root = resolve(pluginsDir(scope, projectPath))
  const folder = resolve(root, name)
  if (folder !== join(root, name) || !(folder === root || folder.startsWith(root + sep)))
    throw new Error('Invalid plugin name (path traversal rejected).')
  return folder
}

function scanScope(scope: 'global' | 'project', projectPath: string | null): PluginEntry[] {
  let dir: string
  try {
    dir = pluginsDir(scope, projectPath)
  } catch {
    return []
  }
  if (!existsSync(dir)) return []
  const out: PluginEntry[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const n of names) {
    const m = parsePluginDir(join(dir, n), scope)
    if (!m) continue
    // Identity is the real on-disk directory name `n`, not the (possibly
    // attacker/author-controlled) manifest-declared m.name -- two folders
    // must never collide on one enabled-state key or uninstall target just
    // because their plugin.json both claim the same display name.
    out.push({ ...m, dirName: n, enabled: isPluginEnabled(scope, n), source: `${scope}:${n}` })
  }
  return out
}

export function listPlugins(
  projectPath: string | null,
  opts?: { trusted?: boolean }
): PluginEntry[] {
  const trusted = opts?.trusted ?? false
  const global = scanScope('global', null)
  const project = trusted && projectPath ? scanScope('project', projectPath) : []
  return [...global, ...project]
}

export function uninstallPlugin(
  scope: 'global' | 'project',
  name: string,
  projectPath: string | null
): void {
  const folder = jailedPluginFolder(scope, name, projectPath)
  if (existsSync(folder)) rmSync(folder, { recursive: true, force: true })
  // Scrub the enabled-state key too, so a plugin later reinstalled under the
  // same directory name doesn't silently inherit the old 'enabled' state —
  // preserves state.ts's "a freshly installed plugin never auto-activates"
  // invariant on reinstall, not just first install.
  setPluginEnabled(scope, name, false)
}
