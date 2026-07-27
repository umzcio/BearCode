# Live Model Discovery — Design

**Date:** 2026-07-26
**Status:** Approved, pending implementation plan
**Extends:** `2026-07-26-models-page-redesign-design.md` (same branch/PR #28, not yet merged)

## Problem

`src/main/providers/registry.ts` hardcodes each provider's model list (`ANTHROPIC_MODELS`,
`GOOGLE_MODELS`, `OPENAI_MODELS`, ...) as static arrays. A new model release means a BearCode
code change before anyone can use it. Verified against live docs (2026-07-26) that three of the
six providers actually expose a models-list API:

- **Anthropic** `GET /v1/models` — id, display_name, max_input_tokens, max_tokens, and a real
  `capabilities` object (image_input, pdf_input, structured_outputs, thinking, code_execution,
  citations, batch, context_management).
- **Google** `models.list` — name, displayName, inputTokenLimit, outputTokenLimit,
  supportedGenerationMethods, and a `thinking` flag.
- **OpenAI** `GET /v1/models` — id, created, owned_by only. No capability or context-window data,
  and known to mix in embeddings/whisper/tts/dall-e/moderation/fine-tuned models alongside chat
  models.

xAI and Perplexity have no such endpoint at all (confirmed against their docs — models are only
documented as static strings); OpenRouter has one but it lists everything the network proxies
(hundreds of models), which is a curation problem, not a discovery problem. All three stay
curated/static exactly as they are today — out of scope for this feature.

## Goal

Replace the static arrays for Anthropic, Google, and OpenAI with a live-preferred, static-fallback
list, so new releases from those three providers appear without a code change, while keeping
LiteLLM's already-synced pricing/capability data as the fallback for everything live discovery
doesn't cover.

## Design

### Merge policy (uniform across all three providers)

One rule, applied per-field: **live wins wherever it has a signal; LiteLLM (or the static curated
entry, for the model list itself) fills whatever live doesn't cover.** If no API key is configured
for a provider, or the live call errors/times out, `listModels()` falls back entirely to today's
static array — same "fail closed" shape Ollama's discovery already uses
(`listOllamaModels`/`fetchOllamaContextWindow` in `registry.ts`), never a hard failure the user has
to notice or work around.

This applies to two things independently:
1. **The model list itself** — id, label, context window. Live-discovered models are merged with
   the static array by id (live wins on collision, for freshness; a model temporarily missing from
   a live response but present in the static array is NOT dropped — the static array is a floor,
   not a ceiling).
2. **Capability flags** — see "Capability merge" below. Only Anthropic and (minimally) Google
   contribute anything here; OpenAI's live endpoint has zero capability signal.

### Per-provider mapping

**Anthropic** (`GET /v1/models`, paginated via `before_id`/`after_id`, needs the configured API key
as `X-Api-Key`):
- `id` → `ModelInfo.id`
- `display_name` → `ModelInfo.label`
- `max_input_tokens` (guard: treat `0`/absent as unknown, not a real value — the docs' own example
  response shows `0` as a placeholder) → `ModelInfo.contextWindow`
- Capability patch (only overlaid on top of the fields Anthropic's payload actually answers):
  - `vision` ← `capabilities.image_input.supported`
  - `responseSchema` ← `capabilities.structured_outputs.supported`
  - `reasoning` ← `capabilities.thinking.supported`
  - `codeExecution` ← `capabilities.code_execution.supported` (see "New capability fields" — no
    LiteLLM fallback exists for this one)
  - `pdfInput` ← `capabilities.pdf_input.supported`
  - `functionCalling`, `webSearch` — **not present in this payload at all.** Always sourced from
    LiteLLM for Anthropic models, live discovery or not.

**Google** (`models.list`, paginated via `pageSize`/`pageToken`, needs the configured API key):
- `name` (strip the `models/` prefix — this is the stable, guaranteed-unique id; `baseModelId` is
  not always present and can collapse distinct versioned models together, so it is NOT used as the
  id) → `ModelInfo.id`
- `displayName` → `ModelInfo.label`
- `inputTokenLimit` → `ModelInfo.contextWindow`
- Capability patch: `reasoning` ← the `thinking` flag. Nothing else in this payload maps to
  `vision`/`responseSchema`/`functionCalling`/`webSearch`/`codeExecution`/`pdfInput` — all of those
  stay LiteLLM-sourced for Google models, same fallback rule as Anthropic's uncovered fields.

**OpenAI** (`GET /v1/models`, needs the configured API key):
- `id` → `ModelInfo.id`. **No `display_name` field exists in this response at all** — if the
  discovered id matches a curated `OPENAI_MODELS` entry, borrow that entry's nicer label; for a
  genuinely new/unrecognized id, `label` falls back to the raw id itself (better than fabricating a
  name, and matches how a brand-new, not-yet-catalogued model already renders elsewhere in this
  feature — no description/tags either, per the existing `modelCatalog.ts` null-fallback).
- `contextWindow` — **not available from this endpoint at all.** Sourced entirely from LiteLLM
  (once synced) or left undefined.
- Capability patch: none — OpenAI's list response has zero capability fields. Every capability flag
  for OpenAI models is always LiteLLM-sourced.
- **Filtering** (the real problem with this provider's endpoint): the raw response mixes chat
  models with embeddings/whisper/tts/dall-e/moderation/fine-tunes, and there is no `mode`/`type`
  field to filter on. Two-layer filter:
  1. **Preferred**: cross-reference each discovered id against LiteLLM's already-synced catalog
     (`settings.modelMetadata[ref]?.mode === 'chat'`) — reuses data this feature already pulls
     instead of hand-maintaining a blacklist that has to be updated every time OpenAI ships a new
     non-chat product category.
  2. **Bootstrap fallback** (only when LiteLLM hasn't been synced yet, so there's nothing to
     cross-reference): a small hardcoded substring blacklist (`embedding`, `whisper`, `tts`,
     `dall-e`, `moderation`, `davinci-002`, `babbage-002`, `realtime`, `audio`, `image`, `video`,
     `computer-use`, `codex`) — deliberately named as a known-imperfect stopgap in the code comment,
     superseded automatically the first time the user syncs.

### New capability fields

Widen `ModelMetadata.capabilities` (currently `functionCalling`/`vision`/`responseSchema`/
`reasoning`/`webSearch`) with two more: `codeExecution`, `pdfInput`. Both need:
- A `ModelDetailModal`/`ModelsTab` chip label (matching the existing `CAPABILITY_LABEL`
  map in `lib/modelRows.ts` — "Code execution", "PDF input").
- A capability-filter dropdown option in `ModelsTab`'s toolbar (matching the existing
  `CAPABILITY_OPTIONS` derivation).
- LiteLLM parsing: `supports_pdf_input` already exists in LiteLLM's schema (verified live,
  2026-07-26) — wire it into `parseLiteLLM`/`metadataFromEntry` in `src/main/pricing/sync.ts`
  alongside the existing 5 flags, so `pdfInput` degrades gracefully everywhere (custom models,
  Google, OpenAI, or Anthropic without a configured key all still get a real answer from LiteLLM).
- **`codeExecution` has no LiteLLM equivalent at all** (verified against a live fetch — the closest
  LiteLLM flag, `supports_computer_use`, is Anthropic's separate browser/screen-control tool, not
  the code-execution tool). This means `codeExecution` is **only ever knowable for Anthropic models,
  and only when live discovery actually ran** (a configured key + a successful fetch this session).
  Everywhere else — Google, OpenAI, custom models, Ollama, or Anthropic models when no key is
  configured yet — it reads as unknown/false. This is a real, permanent gap, not a bug to eventually
  fix; document it as such in the code comment on the new field and in the detail modal (the same
  "Capabilities unknown" treatment the modal already gives fully-uncovered models applies per-field
  here — a chip can be legitimately "unknown" even when its sibling chips have real values).

### Where the live-discovered capability patch lives

`AppSettings.modelMetadata` stays exactly as it is today — a plain, LiteLLM-sourced, persisted map,
written only by the pricing/sync IPC action. Live-discovered capability patches are **not**
persisted into settings at all; they are fetched live, cached in main-process memory for the
process's lifetime (see "Caching" below), and exposed alongside each `ManageableModel` as an
optional patch. `buildModelRows` (the shared row-join helper every UI surface already uses) merges
it at read time: start from `settings.modelMetadata[ref]` (LiteLLM's persisted data, if any), then
overlay any live-discovered patch's fields on top. If there's no LiteLLM entry AND no live patch,
the row's `metadata` stays `null` (today's existing "unknown" behavior) — if there's a live patch
but no LiteLLM entry (a brand-new model LiteLLM hasn't catalogued yet), the row gets a real
`metadata` object built from the live patch alone, with every field the patch doesn't cover
defaulting to `false`/unknown, same shape contract as today.

### Caching and refresh trigger

Mirrors the existing per-process `ollamaContextWindows` cache in `registry.ts` (a `Map` populated
lazily, never expired mid-process): each of the three providers' `listModels()` calls attempts live
discovery **the first time it's called** in a given app run (so a fresh install gets live-fresh
data with zero user action — no "click sync first" requirement), caches the result, and reuses it
for the rest of the session. The existing "Sync metadata" button (Models page header, already
wired to the LiteLLM pricing/capability sync) is extended to **also** clear and repopulate this
cache — one button, one mental model ("this refreshes everything about my models"), not a second
new control to explain.

## Out of Scope

- xAI, Perplexity, OpenRouter — no viable discovery mechanism (none, or too noisy) for any of them;
  stay curated/static exactly as today.
- `citations`/`batch`/`context_management` from Anthropic's live payload — real fields, not mapped
  in this pass; `codeExecution`/`pdfInput` were the two judged worth the UI/filter-dropdown work
  right now.
- Any change to `capabilitiesFor()` (the separate, hand-curated `reasoning`/`strengths`/`costTier`
  table Ursa's classifier routes on, in `registry.ts`) — a live-discovered model shows up as
  manageable/toggleable in the Models UI the moment this ships, but Ursa has zero routing knowledge
  of it until a curated entry is added by hand, same as any custom/Ollama model today. Worth being
  explicit about in the PR description so it doesn't read as more automated than it is.
- Automatic curated-entry generation for newly-discovered models (in `modelCatalog.ts` or
  `capabilitiesFor()`) — a new model still renders with no description/tags/Ursa knowledge until a
  human adds one, exactly like today's custom-model path.
