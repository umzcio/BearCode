# Live-Discovered Models Default Disabled — Design

**Date:** 2026-07-26
**Status:** Approved, pending implementation plan
**Extends:** Live Model Discovery (same branch/PR #28)

## Problem

Live Model Discovery (just shipped) makes a live-discovered model appear in `knownModels()`
already `enabled: true`, mixed in with BearCode's curated models, with nothing distinguishing it.
This defeats the Catalog tab's purpose (a browse-and-enable view for disabled models) — a newly
discovered model never needs "discovering" through Catalog because it's already on by default.

## Goal

Only models BearCode ships (the curated `STATIC_MODELS` arrays) default to enabled. A model that
exists ONLY because live discovery found it defaults to **disabled**, so it shows up in Catalog as
something the user opts into — giving Catalog a real job now that Live Model Discovery exists.
Custom (user-added) models are unaffected (unchanged today: enabled when added).

## Design

- New `AppSettings.enabledLiveModels?: string[]` — an opt-IN allowlist for live-only refs,
  parallel to (not replacing) the existing opt-OUT `disabledModels` list curated/custom models use.
- `ManageableModel` gains `liveOnly: boolean` — true only for a model id that exists in a
  provider's live-discovered list but NOT in that provider's `STATIC_MODELS` array. False for
  every curated model and every custom model.
- `listManageableModels()`'s `enabled` computation branches per model:
  - Curated or custom → `!disabledSet.has(ref)` (unchanged, opt-out).
  - `liveOnly` → `enabledLiveSet.has(ref)` (opt-in, defaults to `false`/disabled).
- `setModelEnabled(ref, enabled)` (the one store action every enable/disable UI path already
  calls — the Models tab toggle, Catalog's Enable button, the detail modal's toggle) looks up the
  row's `liveOnly` flag from the current `manageableModels` state and writes to whichever list
  applies. No UI call site changes — they all already just call `setModelEnabled(ref, enabled)`.

## Catalog layout (addendum — a live screenshot during review showed a real live-discovered
model, "Claude Opus 4.7", already appearing via Anthropic's live API not yet in BearCode's curated
list, confirming the feature works)

Once live-only models default to disabled, Catalog stops being "a handful of curated models to
browse" and becomes "dozens of live-discovered models across every provider" — the current
2-column card grid (icon + name + vendor + description + Enable button per card) doesn't scale to
that volume. Switch `CatalogTab` from a card grid to a **compact row-list, grouped by vendor**:
one line per model (icon, name, truncated one-line description, Enable button) under a section
header per vendor (Anthropic / Google / OpenAI / ...), matching the density conventions the Models
tab's table already establishes elsewhere in this app. Cards suited a short curated browse list;
rows suit a long, scannable one.

## Out of Scope

- Any "new model" visual badge/indicator beyond the existing disabled state — Catalog already
  shows a disabled model as a card with a description; that's enough surfacing for this pass.
- Changing `disabledModels`' semantics for curated/custom models — untouched.
