# Models Page Redesign — Design

**Date:** 2026-07-26
**Status:** Approved, pending implementation plan

## Problem

The current Models page (`src/renderer/src/components/Settings/pages/ModelsPage.tsx`) crams four
unrelated concerns into one long scroll inside the small Settings modal: a default-model picker,
a per-provider toggle list, a permanent 4-field "add a model" form, and a full pricing table that
re-lists every model a second time. There's no search, no filtering, and every model is scanned
twice (once to toggle it, once to see its price). This gets worse as more providers/models are
added — with 6+ providers the list is 20-30+ rows with no way to narrow it down.

## Goal

Pull Models out of the Settings modal into its own full-page view (sidebar stays visible, same
pattern as the sidebar redesign's dedicated Project Page) built around a real, filterable,
sortable data table — one row per model, with capabilities, pricing, and status inline — plus a
popup detail modal for whichever model you click into. Validated interactively against a live
mockup built from a reference screenshot the user supplied, iterated through several rounds
(structural layout, right-rail → popup-modal conversion, header alignment, removing an unresolved
"Overrides" concept, replacing a standalone "Disable model" button with a toggle in the header).
This spec captures that mockup's final, approved state.

## Design

### Page architecture

Models becomes a top-level view, not a Settings-modal page. Sidebar stays visible on the left;
everything else currently in Settings (General, Permissions, Appearance, Providers, etc.) is
unaffected and stays in the modal exactly as it is today. This is the one real architecture change
this spec introduces — flagged explicitly during mockup review, not a silent scope expansion.

### Header

"Models" title + subtitle, with a "Sync metadata" button and a "Last synced Xm ago" status
top-right (renames/extends today's "Sync prices" — see Data Model below).

### Tabs: Models / Catalog / Pricing

Underline-style tab strip, not a segmented pill (deliberately different from the sidebar's
Conversations/ChuckAI toggle — that pattern was tried as one of the earlier rejected directions and
didn't fit this page's density).

- **Models** — the primary view: every currently-known model (enabled or not), the toolbar, table,
  and pagination described below.
- **Catalog** — a lighter card-grid browse view for discovering models not yet enabled, each with a
  one-line description and an "Enable" button. Populated from the same curated model list as
  Models, filtered to `enabled: false`.
- **Pricing** — a focused, pricing-only table (Model / Input / Output / Source) with its own "Sync
  prices" action, for when you just want to compare costs without the rest of the table's columns.

### Toolbar (Models tab)

- **Default model** box — same concept as today's Select, restyled as a labeled box showing the
  provider icon + name.
- **Search** input with a `⌘K` hint, filtering the table live by name/vendor.
- **Filter chips**: vendor, capability, status (each a dropdown — built on the existing shared
  `Menu`/`Popover` primitives per this repo's UI conventions, not hand-rolled).
- **Show enabled only** toggle.
- **Bulk actions** menu (exact action set — enable-all/disable-all/etc. — left to the plan; not
  fully specified in the mockup).

### Table

Columns: star (favorite/pin), Model (provider icon + name + vendor), Context, Capabilities (small
icon chips + "+N" overflow), Pricing per 1M tokens (input/output, two lines), Status, Enabled
(toggle), row menu (⋮). Status has three states: **Available** (green dot), **Provider not
configured** (amber dot + "Configure →" link to the relevant Providers settings page), and
**Unavailable** (red dot + "Check status" link). Pagination below the table (`Showing 1–N of M
models`, page controls, page-size picker). Bottom row: "Add custom model" and "Import models" as
two small actions, "Learn about models" link on the right.

### Detail modal

Clicking a row's ⋮ opens a centered popup modal (dimmed backdrop over the whole page, matching this
app's existing `.modal-overlay` convention from Settings) — **not** a permanently-docked right
rail; that was the mockup's first attempt and was explicitly rejected in favor of a popup.

Header row (vertically centered, not top-aligned — an alignment bug in the mockup itself, worth
calling out to the plan's implementer as a concrete "don't do this" example): provider icon, name +
vendor, an **enabled/disabled toggle** (mirrors the table row's own toggle — this is the model's
disable/enable control; a separate standalone "Disable model" button was tried and explicitly
rejected as redundant with the toggle), a star (favorite) button, a ⋮ (more actions) button, and a
close (×). No tabs inside the modal — an "Overrides" second tab was in the original reference
image but the user decided to drop it outright; there is no BearCode concept behind it. If a real
per-model-overrides feature (parameter defaults, pricing overrides, etc.) is wanted later, it needs
its own separate design — do not resurrect the empty tab.

Body: one-line description, tag chips ("Recommended", "Default", category tags like "Coding" —
all hand-authored, see Data Model), Model ID (LiteLLM) in a monospace row with a copy button, a
Type/Context-window stat pair and a Max-output stat, a Capabilities grid (icon + label per
capability), Pricing (input/output), Status (with the same three-state model as the table), and
Source (`LiteLLM` + last-synced time + a re-sync icon).

## Data Model

This is the part of the redesign that's genuinely new backend work, not just UI:

- **Capabilities and `mode` (Chat/Image/Embedding) are largely already attainable from data
  BearCode already fetches.** `src/main/pricing/sync.ts` already downloads the full LiteLLM
  `model_prices_and_context_window.json` for pricing, but its `LiteLLMEntry` interface only reads
  `input_cost_per_token`/`output_cost_per_token` — everything else in that response is discarded.
  The real file also carries (subject to verification against a live fetch before the plan is
  written — this is going on recollection of the schema, not a fresh check) `max_input_tokens`,
  `max_output_tokens`, a `mode` field, and a set of `supports_*` booleans (`supports_function_calling`,
  `supports_vision`, `supports_response_schema`, `supports_reasoning`, `supports_web_search`).
  Widening `LiteLLMEntry` and `parseLiteLLM` to also capture and persist these — alongside the
  existing price map, in `settings.modelPricing` or a sibling field — is most of this feature's real
  engineering work.
- **Coverage is not universal.** Custom/self-hosted/Ollama models have no LiteLLM catalog entry at
  all (no capabilities, no `mode`) — the UI needs a clear "unknown" state for these, not a blank or
  misleading one. Some real catalog models also have incomplete `supports_*` flags.
- **"Recommended" tags and the one-line descriptions are categorically different**: hand-authored
  editorial content, not sourced from any API. This is an ongoing content-maintenance cost (new
  models need a description/tag written when they're added), not a one-time engineering task. The
  plan should treat this as a small curated dataset BearCode owns, separate from the LiteLLM sync.
- **Provider-configured-status detection** (the amber "Provider not configured" state) needs a real
  check against whichever provider-credentials mechanism `src/renderer/src/components/Settings/pages/ProvidersPage.tsx`
  (or equivalent) already uses — not new plumbing, just a read of existing state.

## Out of Scope

- **Bulk actions' exact action set** — the toolbar has the affordance; which actions it offers
  (enable all filtered, disable all filtered, etc.) is left to the plan.
- **"Import models" flow** — the button exists in the mockup; what it actually imports from (a
  file? another tool's config, echoing the existing agent-config-import feature?) is undesigned.
- **The Catalog tab's actual data source** for "not yet enabled" models beyond the curated list
  already implied by Manage Models today.
- **Per-model parameter/pricing overrides** — explicitly dropped (see Detail modal above), not
  deferred-but-planned. A future design would need to justify this separately.
- **Verifying live LiteLLM field coverage** for BearCode's actual configured models — recommended
  as the first research step of the implementation plan, not part of this design.
