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
    // A hand-created folder whose dirName isn't kebab-case (e.g. `My_Plugin`)
    // would otherwise be listed here and rendered with an enable toggle /
    // uninstall button, but set-enabled/uninstall's validateName rejects any
    // non-kebab-case name -- so a click on either control throws an
    // unhandled rejection. Skip it at discovery time so the UI never offers
    // an action the IPC layer will reject.
    if (!COMMAND_NAME_PATTERN.test(n)) continue
    const m = parsePluginDir(join(dir, n), scope)
    if (!m) continue
    // Identity is the real on-disk directory name `n`, not the (possibly
    // attacker/author-controlled) manifest-declared m.name -- two folders
    // must never collide on one enabled-state key or uninstall target just
    // because their plugin.json both claim the same display name.
    out.push({
      ...m,
      dirName: n,
      enabled: isPluginEnabled(scope, n),
      source: `${scope}:${n}`,
      // Only a direct git clone (prepareInstall's git URL branch) carries a
      // .git dir; a marketplace-subpath install (cpSync of a repo
      // SUBDIRECTORY) never does, so updatePlugin's `git pull` would be a
      // silent no-op for it.
      updatable: existsSync(join(dir, n, '.git'))
    })
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

// The loader bridge: turns enabled plugins into the raw ingredient paths the
// existing pillar loaders (skills/rules/MCP) fold in. `pluginName` here is
// always the on-disk `dirName` (Task 3's identity fix), never the spoofable
// manifest `name` field, so provenance/enable-state/paths all agree on one
// identity. Only ENABLED plugins contribute; project plugins only when the
// caller has already marked the workspace trusted (listPlugins enforces the
// same gate for discovery).
export interface PluginIngredients {
  skillFolders: { pluginName: string; path: string }[]
  ruleFiles: { pluginName: string; path: string }[]
  mcpConfigs: { pluginName: string; path: string }[]
  hookFiles: { pluginName: string; path: string }[]
}

export function enumeratePluginIngredients(
  projectPath: string | null,
  opts?: { trusted?: boolean }
): PluginIngredients {
  const out: PluginIngredients = {
    skillFolders: [],
    ruleFiles: [],
    mcpConfigs: [],
    hookFiles: []
  }
  for (const p of listPlugins(projectPath, opts)) {
    if (!p.enabled) continue
    const root = pluginsDir(p.scope, projectPath)
    const dir = join(root, p.dirName)
    // Path MUST be built from the real on-disk folder name (`s.folder`),
    // never `s.name` -- a SKILL.md's frontmatter `name:` can legitimately
    // override the display name (design 4.1) and differ from the folder it
    // lives in, so using `s.name` here would silently drop every plugin
    // skill that uses that documented override feature (the folder it
    // resolves to simply doesn't exist).
    for (const s of p.skills)
      out.skillFolders.push({ pluginName: p.dirName, path: join(dir, 'skills', s.folder) })
    for (const r of p.rules)
      out.ruleFiles.push({ pluginName: p.dirName, path: join(dir, 'rules', `${r.name}.md`) })
    for (const f of ['mcp.json', 'mcp_config.json']) {
      if (existsSync(join(dir, f))) {
        out.mcpConfigs.push({ pluginName: p.dirName, path: join(dir, f) })
        break
      }
    }
    if (existsSync(join(dir, 'hooks.json')))
      out.hookFiles.push({ pluginName: p.dirName, path: join(dir, 'hooks.json') })
  }
  return out
}
