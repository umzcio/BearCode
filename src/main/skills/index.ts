// Path-jailed skill writes + the settings-page list read model (design 4.4/4.6).
// Every write resolves under the scope's skills root and verifies containment
// (the jailPath idiom) BEFORE any mkdir/write; names must be kebab-case and
// bodies must fit the 64KB cap the loader also enforces. Scripts are never
// executed here -- this module only reads/writes SKILL.md text.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { SkillEntry, SkillInput } from '../../shared/types'
import { loadAgentsContent } from '../agentsDir'
import { isSkillEnabled } from './state'

const MAX_SKILL_BYTES = 64 * 1024

export function skillsDir(source: 'project' | 'global', projectPath: string | null): string {
  if (source === 'global') return join(homedir(), '.bearcode', 'agents', 'skills')
  if (!projectPath) throw new Error('A project must be open to write a project-scope skill.')
  return join(projectPath, '.agents', 'skills')
}

function jailedSkillFolder(
  name: string,
  source: 'project' | 'global',
  projectPath: string | null
): string {
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new Error('Skill name must be kebab-case (lowercase letters, digits, dashes).')
  }
  const root = resolve(skillsDir(source, projectPath))
  const folder = resolve(root, name)
  if (folder !== join(root, name) || !(folder === root || folder.startsWith(root + sep))) {
    throw new Error('Invalid skill name (path traversal rejected).')
  }
  return folder
}

export function renderSkillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

export function writeSkillFile(input: SkillInput, projectPath: string | null): void {
  const md = renderSkillMd(input.name, input.description, input.body)
  if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error(`Skill exceeds the ${MAX_SKILL_BYTES / 1024}KB size cap.`)
  }
  const folder = jailedSkillFolder(input.name, input.scope, projectPath)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), md)
}

export function deleteSkillFolder(
  name: string,
  source: 'project' | 'global',
  projectPath: string | null
): void {
  const folder = jailedSkillFolder(name, source, projectPath)
  if (existsSync(folder)) rmSync(folder, { recursive: true, force: true })
}

function skillEntryFromInput(input: SkillInput, projectPath: string | null): SkillEntry {
  return {
    name: input.name,
    description: input.description,
    source: input.scope,
    enabled: isSkillEnabled(input.name, input.scope, projectPath),
    sizeBytes: Buffer.byteLength(input.body, 'utf8'),
    error: undefined,
    body: input.body
  }
}

export function createSkill(input: SkillInput, projectPath: string | null): SkillEntry {
  writeSkillFile(input, projectPath)
  return skillEntryFromInput(input, projectPath)
}

export function updateSkill(
  originalName: string,
  input: SkillInput,
  projectPath: string | null
): SkillEntry {
  // A rename deletes the old folder after writing the new one (never before, so
  // a write failure can't lose the skill).
  writeSkillFile(input, projectPath)
  if (originalName !== input.name) deleteSkillFolder(originalName, input.scope, projectPath)
  return skillEntryFromInput(input, projectPath)
}

// The settings-page list (design 4.6): all skills (global + project), each with
// its enabled flag, size, and any parse error. Parse-errored skills are
// included (greyed in the UI) with their error surfaced.
export function listSkillEntries(projectPath: string | null): SkillEntry[] {
  // Settings-page management view: show project skills regardless of trust so
  // the user can see/manage them (they are NOT injected into agent context here;
  // the agent-facing @-menu/turn-build paths gate on trust). Mirrors listMemory.
  return loadAgentsContent(projectPath, { trusted: true }).skills.map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
    enabled: isSkillEnabled(s.name, s.source, projectPath),
    sizeBytes: Buffer.byteLength(s.body, 'utf8'),
    error: s.error,
    body: s.body
  }))
}
