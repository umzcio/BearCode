// Parse a plugin directory into a PluginManifest (pure metadata for the review
// card + discovery). Reads disk with the bounded readFileCapped; never throws;
// returns null only when plugin.json is absent/unreadable. Reuses the pillar
// parsers so a plugin's skills/rules are described exactly as the loaders see
// them. No script or hook is ever executed here.
import { basename, join } from 'path'
import { readFileCapped } from '../fsCapped'
import { listSkillFolders } from '../agentsDir'
import { parseSkillFolder } from '../agentsDir/parseSkill'
import { parseRuleFile } from '../agentsDir/parseRule'
import { existsSync, readdirSync } from 'fs'
import type {
  PluginManifest,
  PluginServerSummary,
  PluginSkillSummary,
  PluginRuleSummary
} from '../../shared/types'

const CAP = 64 * 1024

function readJson(path: string): Record<string, unknown> | null {
  const r = readFileCapped(path, CAP)
  if (!r) return null
  try {
    const v = JSON.parse(r.text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parsePluginDir(dir: string, scope: 'global' | 'project'): PluginManifest | null {
  const markerPath = join(dir, 'plugin.json')
  if (!existsSync(markerPath)) return null
  const marker = readJson(markerPath) // may be null when malformed — still a plugin (marker existed)
  const name =
    typeof marker?.name === 'string' && marker.name.trim()
      ? String(marker.name).trim()
      : basename(dir)
  const description =
    typeof marker?.description === 'string' ? String(marker.description) : undefined
  const version = typeof marker?.version === 'string' ? String(marker.version) : undefined

  const skills: PluginSkillSummary[] = []
  // listSkillFolders(dir) returns { name, path } where `path` already points
  // at <dir>/<name>/SKILL.md (not the folder) -- read it directly.
  for (const { name: sName, path } of safeSkillFolders(join(dir, 'skills'))) {
    const raw = readFileCapped(path, CAP)
    if (!raw) continue
    const s = parseSkillFolder(sName, raw.text, scope)
    // `folder` is the real on-disk directory name (`sName`), kept separate
    // from `s.name` (the effective/frontmatter-overridable display name) so
    // downstream path-building never uses an attacker/author-controlled
    // value to address the filesystem.
    if (!s.error) skills.push({ name: s.name, description: s.description, folder: sName })
  }

  const rules: PluginRuleSummary[] = []
  const rulesDir = join(dir, 'rules')
  if (existsSync(rulesDir)) {
    for (const f of safeReaddir(rulesDir)) {
      if (!f.endsWith('.md')) continue
      const raw = readFileCapped(join(rulesDir, f), CAP)
      if (!raw) continue
      const r = parseRuleFile(f.replace(/\.md$/, ''), raw.text, scope)
      if (!r.error) rules.push({ name: r.name, activation: r.activation })
    }
  }

  const servers =
    parseServers(join(dir, 'mcp.json')) ?? parseServers(join(dir, 'mcp_config.json')) ?? []
  const hooks = readJson(join(dir, 'hooks.json'))
  const hookCount = hooks ? Object.keys(hooks).length : 0

  return { name, description, version, scope, skills, rules, servers, hookCount }
}

function parseServers(path: string): PluginServerSummary[] | null {
  const j = readJson(path)
  const raw = j?.mcpServers
  if (!raw || typeof raw !== 'object') return null
  const out: PluginServerSummary[] = []
  for (const [sName, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    const declared = (e.type ?? e.transport) as string | undefined
    const transport = declared === 'stdio' || (e.command && !e.url) ? 'stdio' : 'http'
    const rawArgs = Array.isArray(e.args) ? e.args : undefined
    out.push({
      name: sName,
      transport,
      command: typeof e.command === 'string' ? e.command : undefined,
      args: rawArgs?.every((a) => typeof a === 'string') ? (rawArgs as string[]) : undefined,
      url: typeof e.url === 'string' ? e.url : undefined
    })
  }
  return out
}

function safeSkillFolders(dir: string): { name: string; path: string }[] {
  try {
    return existsSync(dir) ? listSkillFolders(dir) : []
  } catch {
    return []
  }
}
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
