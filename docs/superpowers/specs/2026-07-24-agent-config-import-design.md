# Agent Config Import — Design

**Date:** 2026-07-24
**Status:** Approved, pending implementation plan

## Problem

Users switching to BearCode often already have agent config set up for other tools in
the same project folder — `CLAUDE.md`, `.claude/`, `AGENTS.md`, `.cursor/`, `.windsurf/`,
etc. Today BearCode has no awareness of any of this; it only knows about its own
`.agents/{rules,workflows,skills}` convention (see `src/main/agentsDir/index.ts`,
`hasProjectAgentsConfig`). Setting BearCode up from scratch means redoing work the user
already did elsewhere.

## Goal

On project folder open, detect existing config from other agent tools and offer to
import it into BearCode's own Rules, Skills/Workflows, and MCP registry, reusing the
existing `.agents/` load/trust pipeline rather than inventing a parallel system.

## Scope

**Formats detected (v1):**
- `CLAUDE.md`, `.claude/` — `settings.json` (`mcpServers`), `skills/<name>/SKILL.md`,
  `commands/*.md`, `agents/*.md`
- `AGENTS.md` (Codex / Antigravity-style)
- `.cursorrules`, `.cursor/` — rules, `.cursor/mcp.json`
- `.windsurfrules`, `.windsurf/`

**Out of scope for v1:** hooks (Claude Code `settings.json` hooks, `.claude/hooks/`) and
Claude Code subagents (`.claude/agents/*.md`). These are still *detected* and shown in
the review screen, tagged "not yet supported," rather than silently dropped — no
translator is built for them this round.

## Detection

- Runs once per folder-open, alongside the existing `hasProjectAgentsConfig` check — a
  cheap existence/glob scan for the patterns above, no parsing at this stage.
- Result is compared against a per-project record of what was previously seen,
  imported, or dismissed (see Data Model below).
- The "detected config" banner shows when:
  - new files are found that weren't present at the last scan, **or**
  - it has been ≥7 days since the user dismissed the banner and the files are still
    there.
- Already-imported items never re-trigger this banner — drift on those is handled by
  the separate "Check for updates" flow.
- A manual "Scan this folder for importable config" action also lives in Settings
  (near the Rules/Skills/MCP pages), independent of banner/snooze state, for on-demand
  re-scans.

## Review & Import Flow

"Review & Import" opens a screen listing everything detected, grouped by source
file/dir, each with a checkbox and a preview of the translated result before commit:

```
CLAUDE.md                              [x] Import as Rule
  "You are working on a Next.js app... (312 words)"      [Preview]

.cursor/rules/testing.md               [x] Import as Rule
.claude/skills/pdf-export/             [x] Import as Skill
.claude/settings.json → mcpServers     [ ] Import 2 MCP servers
  - filesystem, github                                    [Preview]

.claude/agents/reviewer.md             [ ] Not yet supported
```

- Naming collisions with existing Rules/Skills get a suffix (e.g. "testing
  (imported)") rather than silently overwriting or blocking the import.
- Unchecked items are left alone — still detected, importable later via manual scan or
  update-check.
- Confirming writes checked items into `.agents/rules/`, `.agents/skills/<name>/`, and
  the MCP registry, then shows a summary toast ("Imported 3 rules, 1 skill, 2 MCP
  servers").

## Translation Mapping

**Rules** — CLAUDE.md, AGENTS.md, `.cursorrules`, `.windsurfrules`:
- Each becomes one BearCode Rule, activation mode **"always"** (matches how these
  tools already treat them: always-in-context).
- `@path` references inside CLAUDE.md (Claude Code's file-import syntax) are resolved
  using the same cross-ref resolution BearCode's own rules already use, and inlined
  once at import time. This is a one-time translation, not a live include — subsequent
  edits to the referenced file are only picked up via "Check for updates."

**Workflows** — `.claude/commands/*.md` → BearCode Workflows (slash commands), the
closest existing concept.

**Skills** — `.claude/skills/<name>/SKILL.md` → direct folder copy into
`.agents/skills/<name>/`. Both already follow the agentskills.io convention, so this
needs little to no transformation beyond the collision-suffix check.

**MCP servers** — `.claude/settings.json` `mcpServers`, `.cursor/mcp.json` → new
project-scoped entries in BearCode's MCP registry (`src/main/mcp/store.ts`), landing
**disabled/untrusted by default** — same as any newly-added MCP server today. Import
never auto-enables or auto-spawns; the user still goes through BearCode's existing
enable/consent step afterward.

## Data Model & Re-sync

New path-keyed table `imported_agent_config`:

| field | purpose |
|---|---|
| `project_path` | keys to the project, same pattern as `project_settings` |
| `source_path` | e.g. `CLAUDE.md`, `.cursor/rules/testing.md` |
| `source_hash` | content hash at last import/check, to detect drift |
| `imported_as` | `{type: 'rule' \| 'skill' \| 'mcp', id}` — points at the created entity |
| `status` | `imported` \| `dismissed` \| `not_supported` |
| `dismissed_at` | drives the 7-day re-remind timer |

**Check for updates:** a button next to each imported item (surfaced in its
Rule/Skill/MCP settings entry, tagged "imported from CLAUDE.md") re-reads
`source_path`, compares hash, and if changed shows a diff (old translated content vs.
new) with **Apply** (re-translate and overwrite that entity) or **Ignore** (bump the
stored hash without changing anything). Never auto-applies.

## Edge Cases

- **Malformed/unparseable files** (e.g. invalid JSON in `.cursor/mcp.json`): shown in
  the review screen as "couldn't parse — skipped"; other detected items still import.
- **Empty/whitespace-only instructions files**: filtered out before display — no
  phantom empty Rule.
- **Untrusted folder**: import is independent of the existing `.agents/` trust gate —
  writing into `.agents/` doesn't require the destination to already be trusted, but
  newly-imported Rules/Skills only take effect once the folder is trusted, same as any
  other rule today. No new trust concept needed.
- **Source deleted before a later "Check for updates"**: shows "source no longer
  found" with an option to detach (keep the imported entity, stop tracking it for
  updates) instead of erroring.

## Testing

- Unit tests per translator (CLAUDE.md → Rule, `.claude/skills` → Skill copy,
  `mcpServers` JSON → registry entries): `@path` resolution, malformed input, naming
  collisions.
- Unit tests for detection/snooze logic: new files vs. previously-dismissed vs. the
  7-day re-remind boundary.
- No new e2e infra needed — fits existing Rules/Skills/MCP settings pages' test
  patterns.
