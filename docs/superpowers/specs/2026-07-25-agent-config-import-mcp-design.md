# Agent Config Import — Plan B: MCP Server Import — Design

**Date:** 2026-07-25
**Status:** Approved, pending implementation plan

## Problem

Plan A (merged as PR #20) built detection and import for another agent tool's
Rules, Workflows, and Skills. It deliberately deferred MCP server import,
since BearCode already has ~90% of that infrastructure: `discoverLocalServers`
(`src/main/mcp/store.ts`) reads Claude Desktop's config and a project's own
`.mcp.json`, and the Connectors page's "Import local…" picker already lets a
user select and import discovered servers. What's missing is coverage of two
more source files — `.claude/settings.json`'s `mcpServers` key and
`.cursor/mcp.json`/`.windsurf/mcp.json` — and a way for MCP servers to show up
in the same unified detection flow Plan A built, rather than only being
reachable by manually opening Connectors.

## Goal

Detect MCP server definitions from `.claude/settings.json`, `.cursor/mcp.json`,
and `.windsurf/mcp.json`, and surface them in the **same** Review & Import
modal Plan A built, alongside Rules/Workflows/Skills, as a fourth "Import as
Connector" bucket. Hooks detection (Claude Code's `.claude/settings.json`
`hooks` key) is explicitly **out of scope** for this plan.

## Detection — extend, don't duplicate

`discoverLocalServers` (`src/main/mcp/store.ts`) already powers the Connectors
page's existing "Import local…" picker. Add two more source reads to that
same function, with new `origin` tags:

- `.claude/settings.json`'s `mcpServers` key → origin `claude-settings-json`
- `.cursor/mcp.json` → origin `cursor-mcp-json`
- `.windsurf/mcp.json` → origin `windsurf-mcp-json`

This means the **existing** Connectors "Import local…" picker gains these
three sources for free, with zero changes to `ConnectorsPage.tsx` or
`ImportLocalPicker`.

A new adapter, `src/main/configImport/mcpCandidates.ts`, wraps
`discoverLocalServers` and maps each `DiscoveredMcpServer` into the same
`ImportCandidate` shape the modal already renders:

- `kind: 'mcp'` (new `ImportKind` variant)
- `buildable: true` always — a discovered MCP entry is already valid parsed
  JSON, there's no translation step that can fail the way a rule/workflow
  file's frontmatter can
- `sourcePath`: a synthetic per-server key, e.g. `.claude/settings.json#filesystem`,
  since one file can define several servers and `imported_config_sources` is
  keyed on `(projectPath, sourcePath)`
- `tool`: mapped from `origin` (`claude-settings-json`/`claude-desktop` →
  `claude-code`; `cursor-mcp-json` → `cursor`; `windsurf-mcp-json` → `windsurf`)
- a preview showing transport (local/remote) + command/URL, matching what
  `ImportLocalPicker` already shows today

## Unified modal integration

The `bearcode:config-import:scan` IPC handler merges `scanImportableConfig`
(rules/workflows/skills, Plan A) with `buildMcpCandidates` (new, this plan)
into one list. `ImportConfigReviewModal` gets a fourth bucket — "Import as
Connector" — rendered with the same checkbox-row pattern as the other three
kinds.

## Import execution — extract, don't fork

The existing `bearcode:mcp:import` IPC handler's body (consent invalidation
via `invalidateStaleConsentOnImport`, `upsertServer`, project/global scoping
based on origin) gets extracted into an exported function,
`importDiscoveredServers(servers: DiscoveredMcpServer[], projectPath: string | null): McpServerView[]`,
in `src/main/mcp/store.ts`. **Both** the existing `bearcode:mcp:import` handler
and the new unified importer call this same function — the Connectors page's
manual import flow is untouched.

`ImportSelection` (`src/main/configImport/importer.ts`, `src/shared/types.ts`)
gains an `mcpServers: string[]` field (selected synthetic source paths).
`applyImportSelection` re-derives the real `DiscoveredMcpServer[]` from a
fresh `discoverLocalServers` call (never trusts client-supplied server
config, mirroring how rule/workflow/skill selections are re-derived from a
fresh scan rather than the client's cached candidate data) and calls
`importDiscoveredServers`.

Imported servers land in the **exact same** untrusted/disabled-by-default
state they do today via the Connectors picker — no new trust concept, no
auto-enable, no auto-spawn. Secrets are never copied (header/env values are
blanked, matching existing behavior) — the user fills them in via
`mcp.setSecret` afterward, same as today.

## Tracking — reuse `imported_config_sources`, don't build a second table

MCP entries get rows in the same table Plan A built
(`importedAsType: 'mcp'`), so banner dismiss/7-day-re-remind logic works
identically across all four kinds with no special-casing in
`shouldShowImportBanner`/`dismissDetectedSources`.

**Not built in this plan:** "Check for updates" for MCP servers (config
drift detection). `checkSourceForUpdate`'s existing `candidateBody` helper
already returns `null` for kinds it doesn't diff (currently just `'skill'`);
extending that same early-return to `'mcp'` is sufficient — MCP entries are
import-once, matching how Skills are handled today. This is a reasonable
future addition, not required now.

## Testing

- Unit tests for `discoverLocalServers`'s three new source reads: valid
  config, malformed JSON (degrades to `[]`, never throws — same as existing
  sources), a file defining multiple servers (multiple synthetic
  `sourcePath`s).
- Unit tests for `mcpCandidates.ts`'s mapping from `DiscoveredMcpServer` to
  `ImportCandidate` (origin → tool mapping, synthetic sourcePath format).
- Unit tests for `importDiscoveredServers` (extracted function): confirm
  identical behavior to the current inline handler body (consent
  invalidation, project/global scoping, secret-blanking) — this is a pure
  refactor of existing, already-tested logic, so tests should assert nothing
  changed.
- Integration test: `applyImportSelection` with a mixed selection (some
  rules, some MCP servers) imports both correctly and records DB rows for
  both.
- No new e2e infra needed — fits the existing Connectors/Rules page test
  patterns.
