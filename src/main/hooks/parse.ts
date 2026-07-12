// Pure parser for hooks.json (design 2026-07-11-hooks-arc-design.md §3): a map
// of hook name -> { enabled?, PreToolUse?, PostToolUse? }. Flattens to one
// record per (name, event, entry). Never throws -- malformed JSON, entries,
// or handlers are simply skipped so a broken hooks.json never blocks the
// other pillars from loading. `consented` is stamped later by state.ts /
// loader.ts, not here (this module has no settings access).
import { COMMAND_NAME_PATTERN, type HookEvent, type HookRecord } from '../../shared/types'

const EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse']
const DEFAULT_TIMEOUT = 30
const MAX_TIMEOUT = 120

export function parseHooksJson(
  raw: string,
  scope: 'global' | 'project' | 'plugin',
  source: string
): Omit<HookRecord, 'consented'>[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []

  const out: Omit<HookRecord, 'consented'>[] = []
  for (const [name, configRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!COMMAND_NAME_PATTERN.test(name)) continue
    if (!configRaw || typeof configRaw !== 'object') continue
    const config = configRaw as Record<string, unknown>
    if (config.enabled === false) continue

    for (const event of EVENTS) {
      const entries = config[event]
      if (!Array.isArray(entries)) continue
      for (const entryRaw of entries) {
        if (!entryRaw || typeof entryRaw !== 'object') continue
        const entry = entryRaw as Record<string, unknown>
        const handlerRaw = entry.handler
        if (!handlerRaw || typeof handlerRaw !== 'object') continue
        const handler = handlerRaw as Record<string, unknown>
        if (handler.type !== 'command') continue
        if (typeof handler.command !== 'string' || !handler.command) continue

        const matcher = typeof entry.matcher === 'string' ? entry.matcher : ''
        const timeout = Math.min(
          MAX_TIMEOUT,
          typeof handler.timeout === 'number' && handler.timeout > 0
            ? handler.timeout
            : DEFAULT_TIMEOUT
        )

        const record: Omit<HookRecord, 'consented'> = {
          name,
          scope,
          event,
          matcher,
          command: handler.command,
          timeout
        }
        if (scope === 'plugin') record.plugin = source
        out.push(record)
      }
    }
  }
  return out
}
