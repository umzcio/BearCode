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

export interface UpdateGlobalHookOriginal {
  name: string
  event: HookEvent
  matcher: string
  command: string
}

// Precise rename/edit: unlike writeGlobalHook (which always replaces an
// entire event's entry array -- fine for a brand-new hook, destructive for
// an edit), this removes exactly the one (event, matcher, command) entry
// the caller loaded and is now editing, leaving every other event and every
// other hand-authored entry under that same event untouched. When the name
// is unchanged, the edited entry is written back under the same name. When
// renamed (original.name !== next.name), the WHOLE remaining config --
// every other event, every sibling entry -- moves with it to the new name
// (merged into whatever the new name already owns); the old name is fully
// vacated rather than left holding orphaned leftovers.
export function updateGlobalHook(
  original: UpdateGlobalHookOriginal,
  next: WriteGlobalHookInput
): void {
  if (!COMMAND_NAME_PATTERN.test(original.name) || !COMMAND_NAME_PATTERN.test(next.name)) {
    throw new Error('Hook name must be kebab-case (lowercase letters, digits, dashes).')
  }
  const file = jailedGlobalHooksFile()
  const map = readGlobalHooksMap(file)

  const rawOld = map[original.name]
  const oldConfig: Record<string, unknown> =
    rawOld && typeof rawOld === 'object' && !Array.isArray(rawOld)
      ? { ...(rawOld as Record<string, unknown>) }
      : {}

  const oldEventEntries = Array.isArray(oldConfig[original.event])
    ? (oldConfig[original.event] as Array<Record<string, unknown>>)
    : []
  const isTargetEntry = (entry: Record<string, unknown>): boolean => {
    const handler =
      entry && typeof entry.handler === 'object' && entry.handler !== null
        ? (entry.handler as Record<string, unknown>)
        : undefined
    return entry?.matcher === original.matcher && handler?.command === original.command
  }
  const remaining = oldEventEntries.filter((entry) => !isTargetEntry(entry))
  if (remaining.length > 0) {
    oldConfig[original.event] = remaining
  } else {
    delete oldConfig[original.event]
  }

  const newEntry = {
    matcher: next.matcher,
    handler: {
      type: 'command',
      command: next.command,
      ...(next.timeout ? { timeout: next.timeout } : {})
    }
  }

  if (original.name === next.name) {
    const targetEventEntries = Array.isArray(oldConfig[next.event])
      ? (oldConfig[next.event] as unknown[])
      : []
    oldConfig[next.event] = [...targetEventEntries, newEntry]
    if (Object.keys(oldConfig).length === 0) {
      delete map[next.name]
    } else {
      map[next.name] = oldConfig
    }
  } else {
    // Renaming moves the WHOLE logical hook -- every other-event array and
    // every sibling entry left in oldConfig belongs to the same hook the
    // user is renaming, so it all moves to the new name too. The old name
    // is fully vacated (never left holding orphaned leftovers).
    delete map[original.name]
    const rawNext = map[next.name]
    const nextConfig: Record<string, unknown> =
      rawNext && typeof rawNext === 'object' && !Array.isArray(rawNext)
        ? { ...(rawNext as Record<string, unknown>) }
        : {}
    for (const [event, entries] of Object.entries(oldConfig)) {
      if (!Array.isArray(entries)) continue
      const existing = Array.isArray(nextConfig[event]) ? (nextConfig[event] as unknown[]) : []
      nextConfig[event] = [...existing, ...entries]
    }
    const nextEventEntries = Array.isArray(nextConfig[next.event])
      ? (nextConfig[next.event] as unknown[])
      : []
    nextConfig[next.event] = [...nextEventEntries, newEntry]
    map[next.name] = nextConfig
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
