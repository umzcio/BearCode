// Parse a plugin directory into a PluginManifest (pure metadata for the review
// card + discovery). Reads disk with the bounded readFileCapped; never throws;
// returns null only when plugin.json is absent/unreadable. Reuses the pillar
// parsers so a plugin's skills/rules are described exactly as the loaders see
// them. No script or hook is ever executed here.
import { basename, join } from 'path'
import { statSync, existsSync } from 'fs'
import { readFileCapped, listDirJailed, readJsonCapped } from '../fsCapped'
import { capMap } from '../agentsDir/lruCap'
import { listSkillFolders } from '../agentsDir'
import { parseSkillFolder } from '../agentsDir/parseSkill'
import { parseRuleFile } from '../agentsDir/parseRule'
import type {
  PluginManifest,
  PluginServerSummary,
  PluginSkillSummary,
  PluginRuleSummary
} from '../../shared/types'

const CAP = 64 * 1024
const MANIFEST_CACHE_CAP = 512

interface JsonCacheEntry {
  mtimeMs: number
  root: string | undefined
  json: Record<string, unknown> | null
}
const jsonCache = new Map<string, JsonCacheEntry>()

// Mirrors agentsDir/index.ts's loadOneRule cache shape (see
// planning/round3-plans/010-hooks-plugin-scan-caching.md): keyed by this
// file's own absolute path + mtime, so a plugin.json/mcp.json/mcp_config.json/
// hooks.json edit is picked up on the next call with no explicit
// invalidation. `root` is stored and compared too, defensively, even though
// in practice a given absolute path is always called with the same root
// (project-scope plugin paths always live under that project's own prefix).
function readJsonCachedByMtime(path: string, root?: string): Record<string, unknown> | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    jsonCache.delete(path)
    return null
  }
  const cached = jsonCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.root === root) return cached.json

  const json = readJsonCapped(path, CAP, root)
  capMap(jsonCache, path, { mtimeMs, root, json }, MANIFEST_CACHE_CAP)
  return json
}

interface SkillEntryCacheEntry {
  mtimeMs: number
  root: string | undefined
  skill: PluginSkillSummary | null
}
const skillEntryCache = new Map<string, SkillEntryCacheEntry>()

// Keyed by the SKILL.md file's own absolute path + mtime. `sName` (the
// on-disk folder name) and `scope` are passed straight through to
// parseSkillFolder exactly as parsePluginDir did inline before this change --
// they are inputs to the parse, not part of what varies the cache (a given
// SKILL.md path is always parsed with the same sName/scope).
function loadCachedPluginSkill(
  path: string,
  sName: string,
  scope: 'global' | 'project',
  root: string | undefined
): PluginSkillSummary | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    skillEntryCache.delete(path)
    return null
  }
  const cached = skillEntryCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.root === root) return cached.skill

  const raw = readFileCapped(path, CAP, root)
  let skill: PluginSkillSummary | null = null
  if (raw) {
    const s = parseSkillFolder(sName, raw.text, scope)
    // `folder` is the real on-disk directory name (`sName`), kept separate
    // from `s.name` (the effective/frontmatter-overridable display name) so
    // downstream path-building never uses an attacker/author-controlled
    // value to address the filesystem.
    if (!s.error) skill = { name: s.name, description: s.description, folder: sName }
  }
  capMap(skillEntryCache, path, { mtimeMs, root, skill }, MANIFEST_CACHE_CAP)
  return skill
}

interface RuleEntryCacheEntry {
  mtimeMs: number
  root: string | undefined
  rule: PluginRuleSummary | null
}
const ruleEntryCache = new Map<string, RuleEntryCacheEntry>()

// Keyed by the rule .md file's own absolute path + mtime. Mirrors
// loadCachedPluginSkill above exactly.
function loadCachedPluginRule(
  path: string,
  rName: string,
  scope: 'global' | 'project',
  root: string | undefined
): PluginRuleSummary | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    ruleEntryCache.delete(path)
    return null
  }
  const cached = ruleEntryCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.root === root) return cached.rule

  const raw = readFileCapped(path, CAP, root)
  let rule: PluginRuleSummary | null = null
  if (raw) {
    const r = parseRuleFile(rName, raw.text, scope)
    if (!r.error) rule = { name: r.name, activation: r.activation }
  }
  capMap(ruleEntryCache, path, { mtimeMs, root, rule }, MANIFEST_CACHE_CAP)
  return rule
}

export function parsePluginDir(
  dir: string,
  scope: 'global' | 'project',
  root?: string
): PluginManifest | null {
  const markerPath = join(dir, 'plugin.json')
  if (!existsSync(markerPath)) return null
  const marker = readJsonCachedByMtime(markerPath, root) // may be null when malformed — still a plugin (marker existed)
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
  for (const { name: sName, path } of safeSkillFolders(join(dir, 'skills'), root)) {
    const s = loadCachedPluginSkill(path, sName, scope, root)
    if (s) skills.push(s)
  }

  const rules: PluginRuleSummary[] = []
  const rulesDir = join(dir, 'rules')
  if (existsSync(rulesDir)) {
    for (const f of safeReaddir(rulesDir, root)) {
      if (!f.endsWith('.md')) continue
      const r = loadCachedPluginRule(join(rulesDir, f), f.replace(/\.md$/, ''), scope, root)
      if (r) rules.push(r)
    }
  }

  const servers =
    parseServers(join(dir, 'mcp.json'), root) ?? parseServers(join(dir, 'mcp_config.json'), root) ?? []
  const hooks = readJsonCachedByMtime(join(dir, 'hooks.json'), root)
  const hookCount = hooks ? Object.keys(hooks).length : 0

  return { name, description, version, scope, skills, rules, servers, hookCount }
}

function parseServers(path: string, root?: string): PluginServerSummary[] | null {
  const j = readJsonCachedByMtime(path, root)
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

function safeSkillFolders(dir: string, root?: string): { name: string; path: string }[] {
  try {
    return existsSync(dir) ? listSkillFolders(dir, root) : []
  } catch {
    return []
  }
}
function safeReaddir(dir: string, root?: string): string[] {
  return listDirJailed(dir, { root }).map((d) => d.name)
}
