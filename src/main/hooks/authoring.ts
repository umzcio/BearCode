// Path-jailed global-hook authoring (design 2026-07-11-hooks-arc-design.md
// §5.1, decision #3): only the global hooks.json is editable in-app --
// project/plugin hooks.json files stay file-managed and read-only. Mirrors
// src/main/skills/index.ts's jailedSkillFolder idiom, applied to the fixed
// hooks.json file target instead of a per-name folder. Hook names must be
// kebab-case (COMMAND_NAME_PATTERN); a write merges into the existing
// name -> config map, replacing only the given event's entry array so a
// hook that already has both PreToolUse and PostToolUse entries doesn't
// lose the other event when one is edited.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { HookEvent } from '../../shared/types'

function globalHooksDir(): string {
  return join(homedir(), '.bearcode', 'agents')
}

function jailedGlobalHooksFile(): string {
  const root = resolve(globalHooksDir())
  const file = resolve(root, 'hooks.json')
  if (file !== join(root, 'hooks.json') || !file.startsWith(root + sep)) {
    throw new Error('Invalid hooks.json path (path traversal rejected).')
  }
  return file
}

function readGlobalHooksMap(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Malformed existing file: treat as empty rather than throw, so a write
    // can still repair it (parity with the loader's never-throw stance).
  }
  return {}
}

function writeGlobalHooksMap(file: string, map: Record<string, unknown>): void {
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(map, null, 2))
}

export interface WriteGlobalHookInput {
  name: string
  event: HookEvent
  matcher: string
  command: string
  timeout?: number
}

export function writeGlobalHook(input: WriteGlobalHookInput): void {
  if (!COMMAND_NAME_PATTERN.test(input.name)) {
    throw new Error('Hook name must be kebab-case (lowercase letters, digits, dashes).')
  }
  const file = jailedGlobalHooksFile()
  const map = readGlobalHooksMap(file)
  const existing =
    map[input.name] && typeof map[input.name] === 'object'
      ? (map[input.name] as Record<string, unknown>)
      : {}
  map[input.name] = {
    ...existing,
    [input.event]: [
      {
        matcher: input.matcher,
        handler: {
          type: 'command',
          command: input.command,
          ...(input.timeout ? { timeout: input.timeout } : {})
        }
      }
    ]
  }
  writeGlobalHooksMap(file, map)
}

export function deleteGlobalHook(name: string): void {
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new Error('Hook name must be kebab-case (lowercase letters, digits, dashes).')
  }
  const file = jailedGlobalHooksFile()
  const map = readGlobalHooksMap(file)
  if (name in map) {
    delete map[name]
    writeGlobalHooksMap(file, map)
  }
}
