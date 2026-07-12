// Pure parser for hooks.json (global/project/plugin). Never throws; malformed
// entries are skipped. See design 2026-07-11-hooks-arc-design.md §3.
import { describe, it, expect } from 'vitest'
import { parseHooksJson } from './parse'

describe('parseHooksJson', () => {
  it('flattens a valid hooks.json into HookRecord-shaped entries', () => {
    const raw = JSON.stringify({
      fmt: {
        PostToolUse: [
          { matcher: 'edit', handler: { type: 'command', command: 'prettier', timeout: 999 } }
        ]
      },
      guard: {
        enabled: false,
        PreToolUse: [{ handler: { type: 'command', command: 'g' } }]
      }
    })
    const recs = parseHooksJson(raw, 'global', 'global')
    // fmt -> one PostToolUse record, timeout capped to 120, matcher 'edit'
    // guard -> skipped entirely because enabled:false
    expect(recs).toEqual([
      { name: 'fmt', scope: 'global', event: 'PostToolUse', matcher: 'edit', command: 'prettier', timeout: 120 }
    ])
  })

  it('returns [] for malformed JSON', () => {
    expect(parseHooksJson('{bad', 'global', 'global')).toEqual([])
  })

  it('tags plugin-scoped records with the plugin source', () => {
    const raw = JSON.stringify({
      hi: { PreToolUse: [{ handler: { type: 'command', command: 'echo hi' } }] }
    })
    const recs = parseHooksJson(raw, 'plugin', 'my-plugin')
    expect(recs).toEqual([
      {
        name: 'hi',
        scope: 'plugin',
        plugin: 'my-plugin',
        event: 'PreToolUse',
        matcher: '',
        command: 'echo hi',
        timeout: 30
      }
    ])
  })

  it('skips entries with a non-kebab name', () => {
    const raw = JSON.stringify({
      Bad_Name: { PreToolUse: [{ handler: { type: 'command', command: 'x' } }] }
    })
    expect(parseHooksJson(raw, 'global', 'global')).toEqual([])
  })

  it('skips entries missing a string command or wrong handler type', () => {
    const raw = JSON.stringify({
      noop: {
        PreToolUse: [
          { handler: { type: 'other', command: 'x' } },
          { handler: { type: 'command' } },
          { handler: { type: 'command', command: 42 } }
        ]
      }
    })
    expect(parseHooksJson(raw, 'global', 'global')).toEqual([])
  })

  it('defaults matcher to "" and timeout to 30 when absent/invalid', () => {
    const raw = JSON.stringify({
      x: { PreToolUse: [{ handler: { type: 'command', command: 'c', timeout: -5 } }] }
    })
    expect(parseHooksJson(raw, 'global', 'global')).toEqual([
      { name: 'x', scope: 'global', event: 'PreToolUse', matcher: '', command: 'c', timeout: 30 }
    ])
  })

  it('returns [] when raw is not a JSON object', () => {
    expect(parseHooksJson('[]', 'global', 'global')).toEqual([])
    expect(parseHooksJson('"hi"', 'global', 'global')).toEqual([])
  })
})
