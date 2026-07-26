# Models Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped, modal-bound Models settings page with a dedicated top-level page — a real filterable/sortable data table (Models tab), a discovery grid (Catalog tab), and a focused pricing table (Pricing tab) — backed by real LiteLLM capability data instead of just pricing.

**Architecture:** A new `src/renderer/src/components/ModelsPage/` folder holds the page and its three tab components plus a detail modal, following the exact "pull out of the Settings modal into a top-level view" pattern the sidebar redesign already established for Projects (`ProjectsIndex`/`ProjectPage`). The Models entry disappears from `SettingsModal`/`SettingsNav` entirely; a new `nav-item` in `Sidebar.tsx` (next to "Projects") opens it via a new `{ kind: 'models' }` view. On the data side, `src/main/pricing/sync.ts`'s LiteLLM fetch is widened to also parse `mode`/`max_input_tokens`/`max_output_tokens`/`supports_*` into a new `ModelMetadataMap`, persisted alongside pricing from the same one-fetch sync action.

**Tech Stack:** Electron (electron-vite) + React 19 + TypeScript (strict) + vitest + React Testing Library. No new dependencies.

## Global Constraints

- Never hand-roll a dropdown or use a native `<select>` — build every picker on the shared `Select` (single-value pickers) or `Menu`/`Popover` (action menus) components in `src/renderer/src/components/{Select.tsx,ui/Menu.tsx,ui/Popover.tsx}`.
- Reuse `EmptyState`, `ErrorCard`, `Toggle`, `Hint`, `ProviderIcon`, and the shared `.chip`/`.status-dot`/`.menu-item`/`page-title`/`page-sub` classes rather than inventing parallel ones.
- Every new popup panel joins the shared modal transition group in `src/renderer/src/components/Settings/Settings.css` (the `.settings-panel, .smithery-panel` selector list at lines 23-24, 32-33, 42-43, 47-48, 62-64) — add the new class name alongside them, never a standalone `@starting-style` block.
- A model reference is always `${providerId}/${modelId}` (first-slash split; OpenRouter ids contain slashes) — never re-derive this, use the existing `${p.id}/${m.id}` construction already used throughout the codebase.
- New `AppSettings` fields are optional & additive — comment them the same way every existing optional field is commented (why it's optional, what old settings coerce to).
- **No placeholder UI ships** (project rule — see the "Pre-ship placeholder gate" precedent): the spec's "Import models" button and the detail modal's "Overrides" tab are explicitly OUT OF SCOPE and must not appear even as disabled/inert controls. The detail modal's ⋮ menu only renders when it has a real action (removing a custom model) — never as a dead button.
- Bulk actions must be real, working actions (enable/disable the currently filtered rows), not a decorative menu.
- The spec's toolbar "Learn about models" link and the detail modal's Source-row re-sync icon have no defined destination/behavior in this design — per the same placeholder rule, they are intentionally OMITTED (not rendered as dead links/buttons), the same way "Import models" is omitted.
- Money renders as `$${n}` (existing convention, e.g. `$5`); token counts render via the new shared `formatTokens` helper (`1M`, `128K`), never raw numbers.
- Run `npx tsc --noEmit` for both the root and any project-specific tsconfig the repo already gates on (check `package.json` scripts — this repo has separate node/web tsc gates per prior work) and the full `npm test` suite before every task is considered done.

---

### Task 1: Widen LiteLLM sync to capture model metadata (not just pricing)

**Files:**
- Modify: `src/shared/pricing.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/pricing/sync.ts`
- Modify: `src/main/pricing/sync.test.ts`
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Produces: `ModelMode`, `ModelMetadata`, `ModelMetadataMap` (in `src/shared/pricing.ts`); `AppSettings.modelMetadata?: ModelMetadataMap`; `parseLiteLLM(raw, refs): { prices: PricingMap; metadata: ModelMetadataMap; unmatched: string[] }`; `syncPricing(refs): Promise<{ prices: PricingMap; metadata: ModelMetadataMap; unmatched: string[] }>`; the `bearcode:pricing:sync` IPC handler now also persists `modelMetadata` and returns `metadataCount`.
- Consumes: nothing new — this is the foundation every later task's capability/mode/context display reads from.

- [ ] **Step 1: Write the failing test for widened `parseLiteLLM`**

Replace `src/main/pricing/sync.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { parseLiteLLM } from './sync'

// Minimal shape of LiteLLM's model_prices_and_context_window.json (per-token USD
// costs + capability/shape fields), verified against a live fetch 2026-07-26.
const fixture = {
  'claude-opus-4-8': {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    mode: 'chat',
    max_input_tokens: 200000,
    max_output_tokens: 32000,
    supports_function_calling: true,
    supports_vision: true
  },
  'gpt-5.1': {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000008,
    mode: 'chat',
    supports_response_schema: true,
    supports_reasoning: true
  },
  embed_only: {
    mode: 'embedding',
    max_input_tokens: 8000
  },
  sample_spec: { note: 'ignored, no cost or shape fields' }
}
const refs = ['anthropic/claude-opus-4-8', 'openai/gpt-5.1', 'embedding/embed_only', 'ollama/llama3']

describe('parseLiteLLM', () => {
  it('matches our refs to LiteLLM keys and converts per-token cost to per-1M', () => {
    const { prices } = parseLiteLLM(fixture, refs)
    expect(prices['anthropic/claude-opus-4-8']).toEqual({ inputPer1M: 5, outputPer1M: 25 })
    expect(prices['openai/gpt-5.1']).toEqual({ inputPer1M: 2, outputPer1M: 8 })
  })

  it('captures mode, context limits, and supports_* flags into metadata', () => {
    const { metadata } = parseLiteLLM(fixture, refs)
    expect(metadata['anthropic/claude-opus-4-8']).toEqual({
      mode: 'chat',
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      capabilities: {
        functionCalling: true,
        vision: true,
        responseSchema: false,
        reasoning: false,
        webSearch: false
      }
    })
    expect(metadata['openai/gpt-5.1']?.capabilities).toEqual({
      functionCalling: false,
      vision: false,
      responseSchema: true,
      reasoning: true,
      webSearch: false
    })
  })

  it('maps an unrecognized LiteLLM mode string to "other"', () => {
    const { metadata } = parseLiteLLM(fixture, refs)
    expect(metadata['embedding/embed_only']?.mode).toBe('embedding')
  })

  it('reports a ref with no matching LiteLLM entry as unmatched', () => {
    const { unmatched } = parseLiteLLM(fixture, refs)
    expect(unmatched).toContain('ollama/llama3')
  })

  it('ignores entries with neither cost nor shape fields', () => {
    const { prices, metadata } = parseLiteLLM(fixture, refs)
    expect(Object.keys(prices)).not.toContain('sample_spec')
    expect(Object.keys(metadata)).not.toContain('sample_spec')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/pricing/sync.test.ts`
Expected: FAIL — `metadata` is `undefined` on the current `parseLiteLLM` return, and the new fields don't exist yet.

- [ ] **Step 3: Add `ModelMetadata` types to `src/shared/pricing.ts`**

Add to `src/shared/pricing.ts` (after the existing `PricingMap` type, before `BUNDLED_PRICES`):

```ts
// A model's capability/shape metadata as reported by LiteLLM's catalog
// (model_prices_and_context_window.json). Populated by the SAME sync action
// that populates PricingMap -- one fetch, two derived maps (see
// src/main/pricing/sync.ts). Absent for a ref LiteLLM doesn't catalog
// (custom models, Ollama) -- callers must render that as "unknown," not as
// every capability being false.
export type ModelMode = 'chat' | 'embedding' | 'image_generation' | 'other'

export interface ModelMetadata {
  mode: ModelMode
  maxInputTokens?: number
  maxOutputTokens?: number
  capabilities: {
    functionCalling: boolean
    vision: boolean
    responseSchema: boolean
    reasoning: boolean
    webSearch: boolean
  }
}
export type ModelMetadataMap = Record<string, ModelMetadata>
```

- [ ] **Step 4: Widen `LiteLLMEntry`/`parseLiteLLM`/`syncPricing` in `src/main/pricing/sync.ts`**

Replace the full file with:

```ts
import type { ModelMetadata, ModelMetadataMap, ModelMode, PricingMap } from '../../shared/pricing'

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// The modelId within a "provider/modelId" ref (split on FIRST slash; OpenRouter
// ids contain slashes).
function modelIdOf(ref: string): string {
  const i = ref.indexOf('/')
  return i === -1 ? ref : ref.slice(i + 1)
}

interface LiteLLMEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_response_schema?: boolean
  supports_reasoning?: boolean
  supports_web_search?: boolean
}

// LiteLLM's `mode` carries many values we don't distinguish in the UI
// (completion, rerank, audio_*, moderation, ...) -- collapse anything outside
// our three UI-relevant modes to 'other' rather than growing the union to
// match LiteLLM's full vocabulary.
const KNOWN_MODES: ReadonlySet<string> = new Set(['chat', 'embedding', 'image_generation'])

function metadataFromEntry(entry: LiteLLMEntry): ModelMetadata {
  const mode: ModelMode = KNOWN_MODES.has(entry.mode ?? '') ? (entry.mode as ModelMode) : 'other'
  return {
    mode,
    maxInputTokens: entry.max_input_tokens,
    maxOutputTokens: entry.max_output_tokens,
    capabilities: {
      functionCalling: entry.supports_function_calling ?? false,
      vision: entry.supports_vision ?? false,
      responseSchema: entry.supports_response_schema ?? false,
      reasoning: entry.supports_reasoning ?? false,
      webSearch: entry.supports_web_search ?? false
    }
  }
}

// A LiteLLM entry carries shape metadata if it has a mode or a context-window
// limit -- both fields are present on essentially every real catalog entry,
// so this is a reliable "this ref has real data" test distinct from the
// price-specific check below.
function hasShapeFields(entry: LiteLLMEntry): boolean {
  return entry.mode != null || entry.max_input_tokens != null || entry.max_output_tokens != null
}

// Match each of our refs to a LiteLLM key: exact modelId, then the full ref
// (covers "openrouter/vendor/model"). per-token USD -> per-1M for price;
// mode/context/supports_* pass through as-is for metadata. A ref counts as
// "unmatched" only if NEITHER price nor shape data was found for it.
export function parseLiteLLM(
  raw: Record<string, LiteLLMEntry>,
  refs: string[]
): { prices: PricingMap; metadata: ModelMetadataMap; unmatched: string[] } {
  const prices: PricingMap = {}
  const metadata: ModelMetadataMap = {}
  const unmatched: string[] = []
  for (const ref of refs) {
    const entry = raw[modelIdOf(ref)] ?? raw[ref]
    if (!entry) {
      unmatched.push(ref)
      continue
    }
    let matched = false
    if (entry.input_cost_per_token != null || entry.output_cost_per_token != null) {
      prices[ref] = {
        inputPer1M: (entry.input_cost_per_token ?? 0) * 1_000_000,
        outputPer1M: (entry.output_cost_per_token ?? 0) * 1_000_000
      }
      matched = true
    }
    if (hasShapeFields(entry)) {
      metadata[ref] = metadataFromEntry(entry)
      matched = true
    }
    if (!matched) unmatched.push(ref)
  }
  return { prices, metadata, unmatched }
}

// Fetch + parse. Caller persists the returned prices/metadata via settings and
// stamps syncedAt. Throws on network/parse failure (surfaced to the UI).
export async function syncPricing(
  refs: string[]
): Promise<{ prices: PricingMap; metadata: ModelMetadataMap; unmatched: string[] }> {
  const res = await fetch(LITELLM_URL)
  if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, LiteLLMEntry>
  return parseLiteLLM(raw, refs)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/pricing/sync.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Add `modelMetadata` to `AppSettings` in `src/shared/types.ts`**

At the top of the file, widen the existing pricing import:

```ts
import type { ModelMetadataMap, PricingMap } from './pricing'
```

Then, immediately after the existing `modelPricingSyncedAt?: number` field (around line 1248), add:

```ts
  // Model capability/shape metadata (mode, context limits, supports_* flags)
  // from LiteLLM's catalog, synced by the same action as modelPricing above
  // (one fetch, two derived maps -- see src/main/pricing/sync.ts). Optional &
  // additive: settings persisted before this feature coerce to {}. Absent for
  // any ref LiteLLM doesn't catalog (custom models, Ollama) -- the UI must
  // render that as "unknown," never as every capability being false.
  modelMetadata?: ModelMetadataMap
```

- [ ] **Step 7: Persist metadata and widen the sync result in `src/main/ipc.ts`**

Find the `bearcode:pricing:sync` handler (around line 727) and replace it:

```ts
  // User-initiated metadata+pricing sync (Models page "Sync metadata" button,
  // and the Pricing tab's own "Sync prices" button -- same action, different
  // copy for context). Runs in main only -- keeps the LiteLLM fetch off the
  // renderer/CSP surface. Persists resolved prices + capability metadata + a
  // shared syncedAt stamp; throws propagate to the UI.
  ipcMain.handle('bearcode:pricing:sync', async () => {
    const refs = allKnownModelRefs()
    const { prices, metadata, unmatched } = await syncPricing(refs)
    const syncedAt = Date.now()
    setSettings({ modelPricing: prices, modelMetadata: metadata, modelPricingSyncedAt: syncedAt })
    return {
      syncedCount: Object.keys(prices).length,
      metadataCount: Object.keys(metadata).length,
      unmatched,
      syncedAt
    }
  })
```

- [ ] **Step 8: Widen the `window.bearcode.pricing.sync` type in `src/shared/types.ts`**

Find (around line 1587):

```ts
  pricing: {
    sync(): Promise<{ syncedCount: number; unmatched: string[]; syncedAt: number }>
  }
```

Replace with:

```ts
  pricing: {
    sync(): Promise<{
      syncedCount: number
      metadataCount: number
      unmatched: string[]
      syncedAt: number
    }>
  }
```

- [ ] **Step 9: Widen the `syncPricing` store action's return type in `src/renderer/src/state/store.ts`**

Find (around line 454):

```ts
  syncPricing(): Promise<{ syncedCount: number; unmatched: string[]; syncedAt: number }>
```

Replace with:

```ts
  syncPricing(): Promise<{
    syncedCount: number
    metadataCount: number
    unmatched: string[]
    syncedAt: number
  }>
```

The action's implementation (around line 1260) needs no change — it already returns whatever `window.bearcode.pricing.sync()` resolves to.

- [ ] **Step 10: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 11: Commit**

```bash
git add src/shared/pricing.ts src/shared/types.ts src/main/pricing/sync.ts src/main/pricing/sync.test.ts src/main/ipc.ts
git commit -m "feat(models): widen LiteLLM sync to capture mode/context/capability metadata"
```

---

### Task 2: Foundational data-layer utilities (icon, editorial catalog, favorites, status, row builder)

**Files:**
- Modify: `src/renderer/src/components/icons.tsx`
- Modify: `src/shared/types.ts`
- Create: `src/shared/modelCatalog.ts`
- Create: `src/shared/modelCatalog.test.ts`
- Create: `src/renderer/src/lib/modelRows.ts`
- Create: `src/renderer/src/lib/modelRows.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `ProviderModels`, `ManageableProvider`, `SettingsInfo` (all `@shared/types`); `PricingMap`, `ModelMetadataMap`, `ModelMode`, `ModelPrice`, `resolvePrice` (all `@shared/pricing`) — from Task 1.
- Produces: `IconStar` (icons.tsx); `AppSettings.favoriteModels?: string[]`; `CatalogInfo`, `catalogInfoFor(ref): CatalogInfo | null` (`src/shared/modelCatalog.ts`); `ModelStatus`, `modelStatus(providerId, providers): ModelStatus`, `ModelRow`, `buildModelRows(manageableModels, providers, settings): ModelRow[]`, `formatTokens(n?): string`, `MODE_LABEL: Record<ModelMode, string>` (`src/renderer/src/lib/modelRows.ts`) — every later UI task builds on `ModelRow`/`buildModelRows`/`formatTokens`.

- [ ] **Step 1: Write the failing test for the editorial catalog**

Create `src/shared/modelCatalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { catalogInfoFor, MODEL_CATALOG } from './modelCatalog'

describe('catalogInfoFor', () => {
  it('returns hand-authored info for a curated model', () => {
    const info = catalogInfoFor('anthropic/claude-sonnet-5')
    expect(info?.description.length).toBeGreaterThan(0)
  })

  it('returns null for a ref with no catalog entry', () => {
    expect(catalogInfoFor('ollama/llama3')).toBeNull()
  })

  it('has an entry for every curated model this settings page manages', () => {
    // One entry per curated built-in model across the six manageable
    // providers (registry.ts's MANAGEABLE list) -- 4 + 3 + 3 + 5 + 3 + 4 = 22.
    expect(Object.keys(MODEL_CATALOG).length).toBe(22)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/modelCatalog.test.ts`
Expected: FAIL — `src/shared/modelCatalog.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/shared/modelCatalog.ts`**

```ts
// Hand-authored editorial content (one-line descriptions + tags) for
// BearCode's curated built-in model list -- NOT sourced from LiteLLM or any
// API, unlike ModelMetadata. This is an ongoing content-maintenance cost: add
// an entry here whenever a curated model is added to
// src/main/providers/registry.ts. A ref with no entry (custom models, Ollama,
// OpenRouter models outside this table) renders with no description/tags --
// never a placeholder string.
export interface CatalogInfo {
  description: string
  tags?: string[]
}

export const MODEL_CATALOG: Record<string, CatalogInfo> = {
  'anthropic/claude-fable-5': {
    description:
      "Anthropic's fastest frontier model, tuned for expressive, low-latency conversation.",
    tags: ['Fast']
  },
  'anthropic/claude-opus-4-8': {
    description:
      "Anthropic's most capable model, best for deep reasoning and complex multi-step work.",
    tags: ['Recommended']
  },
  'anthropic/claude-sonnet-5': {
    description: "A balanced default: strong at coding and writing at a fraction of Opus's cost.",
    tags: ['Default']
  },
  'anthropic/claude-haiku-4-5': {
    description: "Anthropic's smallest, cheapest model -- built for quick, high-volume tasks.",
    tags: ['Fast']
  },
  'openai/gpt-5.6-sol': {
    description: "OpenAI's top reasoning-effort model, best for hard coding and analysis tasks.",
    tags: ['Reasoning']
  },
  'openai/gpt-5.6-terra': {
    description: 'A mid-effort GPT-5.6 variant tuned for general writing and everyday tasks.'
  },
  'openai/gpt-5.6-luna': {
    description: "OpenAI's lightweight GPT-5.6 variant for fast, low-cost coding help.",
    tags: ['Fast']
  },
  'google/gemini-3.1-pro-preview': {
    description: "Google's latest Gemini preview, strong at long-context research tasks.",
    tags: ['Recommended']
  },
  'google/gemini-2.5-pro': {
    description: "Google's general-purpose Gemini model with a very large context window."
  },
  'google/gemini-2.5-flash': {
    description: 'A fast, low-cost Gemini model for everyday tasks.',
    tags: ['Fast']
  },
  'openrouter/deepseek/deepseek-chat': {
    description: "DeepSeek's general chat model, routed through OpenRouter."
  },
  'openrouter/moonshotai/kimi-k3': {
    description: "Moonshot AI's Kimi K3, a long-context model routed through OpenRouter."
  },
  'openrouter/z-ai/glm-5.2': {
    description: "Zhipu AI's GLM 5.2, a general-purpose model routed through OpenRouter."
  },
  'openrouter/deepseek/deepseek-v4-pro': {
    description: "DeepSeek's flagship V4 Pro model, routed through OpenRouter."
  },
  'openrouter/minimax/minimax-m3': {
    description: "MiniMax's M3 model, routed through OpenRouter."
  },
  'perplexity/sonar': {
    description: "Perplexity's web-grounded chat model -- every answer cites live sources."
  },
  'perplexity/sonar-pro': {
    description: "A stronger, longer-context version of Perplexity's web-grounded Sonar.",
    tags: ['Recommended']
  },
  'perplexity/sonar-reasoning-pro': {
    description: 'Sonar Pro with an added reasoning pass before answering.',
    tags: ['Reasoning']
  },
  'xai/grok-4.5': {
    description: "xAI's general-purpose Grok model with real function calling."
  },
  'xai/grok-4.20-multi-agent': {
    description:
      "xAI's research mode: parallel server-side agents that search and cross-reference with citations.",
    tags: ['Research']
  },
  'xai/grok-4.3': {
    description: 'A long-context Grok model for general-purpose tasks.'
  },
  'xai/grok-4-fast': {
    description: "xAI's fastest, lowest-cost Grok model.",
    tags: ['Fast']
  }
}

export function catalogInfoFor(ref: string): CatalogInfo | null {
  return MODEL_CATALOG[ref] ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/modelCatalog.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Add `favoriteModels` to `AppSettings` in `src/shared/types.ts`**

Immediately after the `modelMetadata?: ModelMetadataMap` field added in Task 1, add:

```ts
  // Model refs the user starred in the Models page. Optional & additive:
  // settings persisted before this feature coerce to [].
  favoriteModels?: string[]
```

- [ ] **Step 6: Add `IconStar` to `src/renderer/src/components/icons.tsx`**

Add after `IconPin` (around line 177):

```ts
export const IconStar = icon(
  <polygon points="12 3 14.9 9.1 21.6 9.8 16.6 14.3 17.9 21 12 17.6 6.1 21 7.4 14.3 2.4 9.8 9.1 9.1" />
)
```

- [ ] **Step 7: Write the failing test for `modelStatus`/`buildModelRows`/`formatTokens`**

Create `src/renderer/src/lib/modelRows.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ManageableProvider, ProviderModels } from '@shared/types'
import { buildModelRows, formatTokens, modelStatus } from './modelRows'

const providers: ProviderModels[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    color: '#d97757',
    requiresKey: true,
    keyConfigured: true,
    reachable: true,
    models: []
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    color: '#9ad0b7',
    requiresKey: true,
    keyConfigured: false,
    reachable: true,
    models: []
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    color: '#3ecf8e',
    requiresKey: false,
    keyConfigured: true,
    reachable: false,
    models: []
  }
]

describe('modelStatus', () => {
  it('is available when the key is configured and the provider is reachable', () => {
    expect(modelStatus('anthropic', providers)).toBe('available')
  })
  it('is not-configured when the key is missing', () => {
    expect(modelStatus('openai', providers)).toBe('not-configured')
  })
  it('is unavailable when the provider is unreachable (e.g. Ollama down)', () => {
    expect(modelStatus('ollama', providers)).toBe('unavailable')
  })
  it('is unavailable for a provider id with no matching entry', () => {
    expect(modelStatus('xai', providers)).toBe('unavailable')
  })
})

describe('formatTokens', () => {
  it('formats millions', () => expect(formatTokens(1_000_000)).toBe('1M'))
  it('formats a non-round million with one decimal', () =>
    expect(formatTokens(1_050_000)).toBe('1.1M'))
  it('formats thousands', () => expect(formatTokens(200_000)).toBe('200K'))
  it('returns an em dash for missing input', () => expect(formatTokens(undefined)).toBe('—'))
})

describe('buildModelRows', () => {
  const manageableModels: ManageableProvider[] = [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#d97757',
      models: [
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000, custom: false, enabled: true }
      ]
    }
  ]

  it('joins a manageable model with its provider status, price, metadata, catalog info, and favorite flag', () => {
    const rows = buildModelRows(manageableModels, providers, {
      modelPricing: { 'anthropic/claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 } },
      modelMetadata: {
        'anthropic/claude-sonnet-5': {
          mode: 'chat',
          maxOutputTokens: 8000,
          capabilities: {
            functionCalling: true,
            vision: false,
            responseSchema: false,
            reasoning: false,
            webSearch: false
          }
        }
      },
      favoriteModels: ['anthropic/claude-sonnet-5']
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.ref).toBe('anthropic/claude-sonnet-5')
    expect(row.status).toBe('available')
    expect(row.price).toEqual({ inputPer1M: 3, outputPer1M: 15 })
    expect(row.priceSource).toBe('synced')
    expect(row.metadata?.capabilities.functionCalling).toBe(true)
    expect(row.catalog?.description.length).toBeGreaterThan(0)
    expect(row.favorite).toBe(true)
  })

  it('leaves metadata/catalog null and favorite false for an unknown/uncatalogued model', () => {
    const rows = buildModelRows(
      [
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#9ad0b7',
          models: [{ id: 'my-custom', label: 'My Custom', custom: true, enabled: true }]
        }
      ],
      providers,
      {}
    )
    expect(rows[0].metadata).toBeNull()
    expect(rows[0].catalog).toBeNull()
    expect(rows[0].favorite).toBe(false)
    expect(rows[0].priceSource).toBeNull()
  })
})
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/modelRows.test.ts`
Expected: FAIL — `src/renderer/src/lib/modelRows.ts` doesn't exist yet.

- [ ] **Step 9: Create `src/renderer/src/lib/modelRows.ts`**

```ts
import type {
  ManageableProvider,
  ModelMetadata,
  ModelMetadataMap,
  ModelMode,
  ModelPrice,
  PricingMap,
  ProviderId,
  ProviderModels
} from '@shared/types'
import { resolvePrice } from '@shared/pricing'
import { catalogInfoFor, type CatalogInfo } from '@shared/modelCatalog'

export type ModelStatus = 'available' | 'not-configured' | 'unavailable'

// Cross-references a manageable-model row's provider against the live
// `providers` slice (keyConfigured/reachable) to derive the 3-state status the
// Models table/detail-modal show. Pure + synchronous: no IPC here, just a join
// over data the store already has.
export function modelStatus(
  providerId: string,
  providers: Pick<ProviderModels, 'id' | 'keyConfigured' | 'reachable'>[]
): ModelStatus {
  const p = providers.find((x) => x.id === providerId)
  if (!p || !p.reachable) return 'unavailable'
  if (!p.keyConfigured) return 'not-configured'
  return 'available'
}

export const MODE_LABEL: Record<ModelMode, string> = {
  chat: 'Chat',
  embedding: 'Embedding',
  image_generation: 'Image generation',
  other: 'Other'
}

// n >= 1M -> "1M" (one decimal only if not a round million); else "NNNK".
// Missing/zero input -> an em dash, the table/modal's shared "unknown" glyph.
export function formatTokens(n?: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(n / 1000)}K`
}

export interface ModelRow {
  ref: string
  providerId: ProviderId
  providerDisplayName: string
  providerColor: string
  id: string
  label: string
  custom: boolean
  enabled: boolean
  contextWindow?: number
  status: ModelStatus
  price: ModelPrice | null
  priceSource: 'synced' | 'default' | null
  metadata: ModelMetadata | null
  catalog: CatalogInfo | null
  favorite: boolean
}

// The single row-shaping join every Models-page surface (table, catalog grid,
// detail modal) builds its view from -- one manageable model x its provider's
// live status x synced/bundled price x synced capability metadata x
// hand-authored catalog info x the user's favorite set. Pure: takes every
// input explicitly so every reader resolves the SAME row for the same data.
export function buildModelRows(
  manageableModels: ManageableProvider[],
  providers: Pick<ProviderModels, 'id' | 'keyConfigured' | 'reachable'>[],
  settings: { modelPricing?: PricingMap; modelMetadata?: ModelMetadataMap; favoriteModels?: string[] }
): ModelRow[] {
  const favorites = new Set(settings.favoriteModels ?? [])
  const rows: ModelRow[] = []
  for (const p of manageableModels) {
    for (const m of p.models) {
      const ref = `${p.id}/${m.id}`
      const price = resolvePrice(ref, settings.modelPricing)
      rows.push({
        ref,
        providerId: p.id,
        providerDisplayName: p.displayName,
        providerColor: p.color,
        id: m.id,
        label: m.label,
        custom: m.custom,
        enabled: m.enabled,
        contextWindow: m.contextWindow,
        status: modelStatus(p.id, providers),
        price,
        priceSource: settings.modelPricing?.[ref] ? 'synced' : price ? 'default' : null,
        metadata: settings.modelMetadata?.[ref] ?? null,
        catalog: catalogInfoFor(ref),
        favorite: favorites.has(ref)
      })
    }
  }
  return rows
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/modelRows.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 11: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/src/components/icons.tsx src/shared/types.ts src/shared/modelCatalog.ts src/shared/modelCatalog.test.ts src/renderer/src/lib/modelRows.ts src/renderer/src/lib/modelRows.test.ts
git commit -m "feat(models): add favorites, editorial catalog, and a shared model-row builder"
```

---

### Task 3: Model detail modal

**Files:**
- Create: `src/renderer/src/components/ModelsPage/ModelDetailModal.tsx`
- Create: `src/renderer/src/components/ModelsPage/ModelDetailModal.css`
- Create: `src/renderer/src/components/ModelsPage/ModelDetailModal.test.tsx`
- Modify: `src/renderer/src/components/Settings/Settings.css`

**Interfaces:**
- Consumes: `buildModelRows`, `formatTokens`, `MODE_LABEL` (Task 2's `../../lib/modelRows`); store slices `manageableModels`, `providers`, `settings`, and actions `setModelEnabled`, `saveSettings`, `removeCustomModel` (all already exist on `useAppStore`); `Menu`/`Popover`, `Toggle`, `Hint`, `ProviderIcon`, `IconClose`/`IconCopy`/`IconDots`/`IconStar`, `useAnimatedUnmount`, `useModalDialog`, `relativeAge`.
- Produces: `ModelDetailModal({ modelRef, onClose }): JSX.Element | null` — Task 4 renders this when a row's ⋮ is clicked.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ModelsPage/ModelDetailModal.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { ModelDetailModal } from './ModelDetailModal'

const baseState = {
  manageableModels: [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#d97757',
      models: [
        {
          id: 'claude-sonnet-5',
          label: 'Claude Sonnet 5',
          contextWindow: 1_000_000,
          custom: false,
          enabled: true
        }
      ]
    },
    {
      id: 'openai',
      displayName: 'OpenAI',
      color: '#9ad0b7',
      models: [{ id: 'my-custom', label: 'My Custom', custom: true, enabled: false }]
    }
  ],
  providers: [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#d97757',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: []
    },
    {
      id: 'openai',
      displayName: 'OpenAI',
      color: '#9ad0b7',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: []
    }
  ],
  settings: {
    modelPricing: { 'anthropic/claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 } },
    modelMetadata: {
      'anthropic/claude-sonnet-5': {
        mode: 'chat' as const,
        maxOutputTokens: 8000,
        capabilities: {
          functionCalling: true,
          vision: false,
          responseSchema: false,
          reasoning: false,
          webSearch: false
        }
      }
    },
    favoriteModels: []
  }
}

describe('ModelDetailModal', () => {
  it('renders name, vendor, price, and an "on" capability', () => {
    useAppStore.setState(baseState as never)
    render(<ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />)
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText(/\$3 in.*\$15 out/)).toBeTruthy()
    expect(document.querySelector('.mdp-cap.on')).toBeTruthy()
  })

  it('shows "Capabilities unknown" for a model with no LiteLLM metadata', () => {
    useAppStore.setState(baseState as never)
    render(<ModelDetailModal modelRef="openai/my-custom" onClose={vi.fn()} />)
    expect(screen.getByText(/Capabilities unknown/)).toBeTruthy()
  })

  it('toggles enabled via the header switch', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ ...baseState, setModelEnabled } as never)
    render(<ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('switch', { name: /Claude Sonnet 5 enabled/i }))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-sonnet-5', false)
  })

  it('only shows the ⋮ menu for a custom model, offering Remove', () => {
    useAppStore.setState(baseState as never)
    const { rerender } = render(
      <ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />
    )
    expect(screen.queryByLabelText('More actions')).toBeNull()
    rerender(<ModelDetailModal modelRef="openai/my-custom" onClose={vi.fn()} />)
    expect(screen.getByLabelText('More actions')).toBeTruthy()
  })

  it('removes a custom model via the ⋮ menu and closes', () => {
    const removeCustomModel = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    useAppStore.setState({ ...baseState, removeCustomModel } as never)
    render(<ModelDetailModal modelRef="openai/my-custom" onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('More actions'))
    fireEvent.click(screen.getByText('Remove custom model'))
    expect(removeCustomModel).toHaveBeenCalledWith('openai', 'my-custom')
    expect(onClose).toHaveBeenCalled()
  })

  it('toggles favorite via saveSettings', () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ ...baseState, saveSettings } as never)
    render(<ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Favorite'))
    expect(saveSettings).toHaveBeenCalledWith({ favoriteModels: ['anthropic/claude-sonnet-5'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelDetailModal.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `src/renderer/src/components/ModelsPage/ModelDetailModal.tsx`**

```tsx
import { useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import { useModalDialog } from '../../lib/useModalDialog'
import { buildModelRows, formatTokens, MODE_LABEL } from '../../lib/modelRows'
import { relativeAge } from '../../lib/time'
import { ProviderIcon } from '../ProviderIcon'
import { Toggle } from '../Toggle'
import { Hint } from '../Hint'
import { Menu } from '../ui/Menu'
import { IconClose, IconCopy, IconDots, IconStar } from '../icons'
import './ModelDetailModal.css'

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  'not-configured': 'Provider not configured',
  unavailable: 'Unavailable'
}

const CAPABILITY_LABELS: {
  key: 'functionCalling' | 'vision' | 'responseSchema' | 'reasoning' | 'webSearch'
  label: string
}[] = [
  { key: 'functionCalling', label: 'Function calling' },
  { key: 'vision', label: 'Vision' },
  { key: 'responseSchema', label: 'Structured output' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'webSearch', label: 'Web search' }
]

// The Models page's popup detail view (not a docked rail -- that direction was
// mocked and explicitly rejected during design). Always rendered mounted by
// its caller only while a ref is selected; this component itself owns its
// exit animation via useAnimatedUnmount so a caller can flip to `null` and
// this still animates out.
export function ModelDetailModal({
  modelRef,
  onClose
}: {
  modelRef: string
  onClose: () => void
}): React.JSX.Element | null {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const removeCustomModel = useAppStore((s) => s.removeCustomModel)
  const { mounted, state } = useAnimatedUnmount(true)
  const { ref: dialogRef, dialogProps } = useModalDialog(onClose)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const row = settings
    ? buildModelRows(manageableModels, providers, settings).find((r) => r.ref === modelRef)
    : undefined

  if (!mounted || !settings || !row) return null

  const toggleFavorite = (): void => {
    const set = new Set(settings.favoriteModels ?? [])
    if (set.has(row.ref)) set.delete(row.ref)
    else set.add(row.ref)
    void saveSettings({ favoriteModels: [...set] })
  }

  return (
    <div
      className="modal-overlay open"
      data-state={state}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="model-detail-panel"
        data-state={state}
        ref={dialogRef}
        {...dialogProps}
        aria-label={`${row.label} details`}
      >
        <div className="mdp-head">
          <ProviderIcon provider={row.providerId} size={22} />
          <div className="mdp-headtext">
            <div className="mdp-name">{row.label}</div>
            <div className="mdp-vendor">{row.providerDisplayName}</div>
          </div>
          <Toggle
            checked={row.enabled}
            ariaLabel={`${row.label} enabled`}
            onChange={(on) => void setModelEnabled(row.ref, on)}
          />
          <Hint label={row.favorite ? 'Unfavorite' : 'Favorite'}>
            <button
              type="button"
              className={'mdp-icon-btn' + (row.favorite ? ' active' : '')}
              aria-label={row.favorite ? 'Unfavorite' : 'Favorite'}
              onClick={toggleFavorite}
            >
              <IconStar size={16} />
            </button>
          </Hint>
          {row.custom ? (
            <>
              <Hint label="More actions">
                <button
                  ref={menuBtnRef}
                  type="button"
                  className="mdp-icon-btn"
                  aria-label="More actions"
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <IconDots size={16} />
                </button>
              </Hint>
              <Menu
                anchorRef={menuBtnRef}
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                groups={[{ items: [{ value: 'remove', label: 'Remove custom model', danger: true }] }]}
                onSelect={() => {
                  void removeCustomModel(row.providerId, row.id)
                  setMenuOpen(false)
                  onClose()
                }}
                ariaLabel="Model actions"
                placement="bottom-end"
              />
            </>
          ) : null}
          <Hint label="Close" side="bottom">
            <button type="button" className="mdp-icon-btn" aria-label="Close" onClick={onClose}>
              <IconClose size={16} />
            </button>
          </Hint>
        </div>

        <div className="mdp-body">
          {row.catalog?.description ? <div className="mdp-desc">{row.catalog.description}</div> : null}
          {row.catalog?.tags?.length ? (
            <div className="mdp-tags">
              {row.catalog.tags.map((t) => (
                <span className="chip" key={t}>
                  {t}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mdp-row">
            <span className="mdp-label">Model ID</span>
            <span className="mdp-mono">
              {row.ref}
              <button
                type="button"
                className="mdp-copy"
                aria-label="Copy model ID"
                onClick={() => void navigator.clipboard.writeText(row.ref)}
              >
                <IconCopy size={13} />
              </button>
            </span>
          </div>

          <div className="mdp-stats">
            <div className="mdp-stat">
              <span className="mdp-stat-label">Type</span>
              <span className="mdp-stat-value">
                {row.metadata ? MODE_LABEL[row.metadata.mode] : 'Unknown'}
              </span>
            </div>
            <div className="mdp-stat">
              <span className="mdp-stat-label">Context window</span>
              <span className="mdp-stat-value">{formatTokens(row.contextWindow)}</span>
            </div>
            <div className="mdp-stat">
              <span className="mdp-stat-label">Max output</span>
              <span className="mdp-stat-value">{formatTokens(row.metadata?.maxOutputTokens)}</span>
            </div>
          </div>

          <div className="mdp-caps">
            {row.metadata ? (
              CAPABILITY_LABELS.map(({ key, label }) => (
                <span
                  className={'mdp-cap' + (row.metadata!.capabilities[key] ? ' on' : '')}
                  key={key}
                >
                  {label}
                </span>
              ))
            ) : (
              <span className="mdp-cap-unknown">Capabilities unknown (not in LiteLLM's catalog)</span>
            )}
          </div>

          <div className="mdp-row">
            <span className="mdp-label">Pricing</span>
            <span className="mdp-value">
              {row.price
                ? `$${row.price.inputPer1M} in / $${row.price.outputPer1M} out per 1M tokens`
                : 'Unknown'}
            </span>
          </div>

          <div className="mdp-row">
            <span className="mdp-label">Status</span>
            <span className="mdp-value">
              <span
                className={
                  'status-dot' +
                  (row.status === 'available'
                    ? ' ok'
                    : row.status === 'not-configured'
                      ? ' warn'
                      : ' err')
                }
              />
              {STATUS_LABEL[row.status]}
            </span>
          </div>

          <div className="mdp-source">
            Source: LiteLLM
            {settings.modelPricingSyncedAt
              ? ` · synced ${relativeAge(settings.modelPricingSyncedAt)}`
              : ' · not yet synced'}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add `.mdp-*` styles + the 3-state `.status-dot` variants to CSS**

Create `src/renderer/src/components/ModelsPage/ModelDetailModal.css`:

```css
.model-detail-panel {
  width: 520px;
  max-width: calc(100vw - 80px);
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  background: var(--bg-panel);
  border-radius: 14px;
  border: 1px solid var(--border-soft);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
}
.mdp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border-soft);
}
.mdp-headtext {
  flex: 1;
  min-width: 0;
}
.mdp-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.mdp-vendor {
  font-size: 12px;
  color: var(--text-dim);
}
.mdp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.mdp-icon-btn:hover {
  background: var(--wash);
  color: var(--text);
}
.mdp-icon-btn.active {
  color: var(--yellow, #e0b23e);
}
.mdp-icon-btn.active svg {
  fill: currentColor;
}
.mdp-body {
  padding: 16px 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mdp-desc {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.5;
}
.mdp-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mdp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.mdp-label {
  color: var(--text-dim);
}
.mdp-value {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}
.mdp-mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}
.mdp-copy {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  display: inline-flex;
  padding: 2px;
}
.mdp-copy:hover {
  color: var(--text);
}
.mdp-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.mdp-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mdp-stat-label {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.mdp-stat-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.mdp-caps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mdp-cap {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--wash);
  color: var(--text-dim);
}
.mdp-cap.on {
  background: var(--green-wash, rgba(62, 207, 142, 0.15));
  color: var(--green, #3ecf8e);
}
.mdp-cap-unknown {
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
}
.mdp-source {
  font-size: 11.5px;
  color: var(--text-dim);
}
.status-dot.warn {
  background: var(--yellow, #e0b23e);
}
.status-dot.err {
  background: var(--red, #e0546e);
}
```

Import it from the component (already done via `import './ModelDetailModal.css'` above).

In `src/renderer/src/components/Settings/Settings.css`, add `.model-detail-panel` to each of the four selector lists that currently read `.settings-panel, .smithery-panel` (lines ~23-24, ~32-33, ~42-43, ~47-48, ~62-64), e.g.:

```css
.settings-panel,
.smithery-panel,
.model-detail-panel {
```

(repeat for every occurrence of that pair in the file, including inside the `@media (prefers-reduced-motion: reduce)` block and the `[data-state='closing']` rules).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelDetailModal.test.tsx`
Expected: PASS, all 6 tests.

- [ ] **Step 6: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ModelsPage/ModelDetailModal.tsx src/renderer/src/components/ModelsPage/ModelDetailModal.css src/renderer/src/components/ModelsPage/ModelDetailModal.test.tsx src/renderer/src/components/Settings/Settings.css
git commit -m "feat(models): add the model detail popup modal"
```

---

### Task 4: Models tab — toolbar, table, pagination

**Files:**
- Create: `src/renderer/src/components/ModelsPage/ModelsTab.tsx`
- Create: `src/renderer/src/components/ModelsPage/ModelsTab.css`
- Create: `src/renderer/src/components/ModelsPage/ModelsTab.test.tsx`

**Interfaces:**
- Consumes: `buildModelRows`, `formatTokens`, `ModelRow`, `ModelStatus` (Task 2); `ModelDetailModal` (Task 3); store slices `manageableModels`, `providers`, `settings` + action `setModelEnabled`, `saveSettings`; `Select`, `Toggle`, `EmptyState`, `ProviderIcon`, `IconSearch`/`IconStar`.
- Produces: `ModelsTab(): JSX.Element` — Task 8's page shell renders this under the "Models" tab. No props: it is fully self-contained (owns its own filter/pagination/modal-open state).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ModelsPage/ModelsTab.test.tsx`:

```tsx
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { ModelsTab } from './ModelsTab'

function seed(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    manageableModels: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        models: [
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000, custom: false, enabled: true },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000, custom: false, enabled: false }
        ]
      },
      {
        id: 'openai',
        displayName: 'OpenAI',
        color: '#9ad0b7',
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_050_000, custom: false, enabled: true }
        ]
      }
    ],
    providers: [
      { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] },
      { id: 'openai', displayName: 'OpenAI', color: '#9ad0b7', requiresKey: true, keyConfigured: false, reachable: true, models: [] }
    ],
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [], defaultModelRef: null },
    ...overrides
  } as never)
}

describe('ModelsTab', () => {
  it('renders one row per manageable model across every provider', () => {
    seed()
    render(<ModelsTab />)
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.getByText('GPT-5.6 Sol')).toBeTruthy()
  })

  it('filters by search text against the model label', () => {
    seed()
    render(<ModelsTab />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'opus' } })
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.queryByText('GPT-5.6 Sol')).toBeNull()
  })

  it('"show enabled only" hides the disabled row', () => {
    seed()
    render(<ModelsTab />)
    fireEvent.click(screen.getByRole('switch', { name: /show enabled only/i }))
    expect(screen.queryByText('Claude Haiku 4.5')).toBeNull()
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
  })

  it('renders the provider-not-configured status with a Configure link for a model under an unconfigured provider', () => {
    const openSettings = vi.fn()
    seed({ openSettings })
    render(<ModelsTab />)
    const row = screen.getByText('GPT-5.6 Sol').closest('.mt-row') as HTMLElement
    expect(within(row).getByText('Provider not configured')).toBeTruthy()
    fireEvent.click(within(row).getByText('Configure →'))
    expect(openSettings).toHaveBeenCalledWith('providers')
  })

  it('toggles a row enabled via its inline switch', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    seed({ setModelEnabled })
    render(<ModelsTab />)
    const row = screen.getByText('Claude Haiku 4.5').closest('.mt-row') as HTMLElement
    fireEvent.click(within(row).getByRole('switch'))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-haiku-4-5', true)
  })

  it('opens the detail modal from a row\'s ⋮ button', () => {
    seed()
    render(<ModelsTab />)
    const row = screen.getByText('Claude Opus 4.8').closest('.mt-row') as HTMLElement
    fireEvent.click(within(row).getByLabelText('More actions'))
    expect(screen.getByLabelText('Claude Opus 4.8 details')).toBeTruthy()
  })

  it('renders the default-model picker and saves a new choice', () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    seed({ saveSettings })
    render(<ModelsTab />)
    fireEvent.click(screen.getByLabelText('Default model'))
    fireEvent.click(screen.getByText('OpenAI: GPT-5.6 Sol'))
    expect(saveSettings).toHaveBeenCalledWith({ defaultModelRef: 'openai/gpt-5.6-sol' })
  })

  it('paginates when there are more rows than the page size', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      label: `Model ${i}`,
      custom: false,
      enabled: true
    }))
    seed({
      manageableModels: [{ id: 'anthropic', displayName: 'Anthropic', color: '#d97757', models: many }]
    })
    render(<ModelsTab />)
    fireEvent.click(screen.getByLabelText('Page size'))
    fireEvent.click(screen.getByText('10'))
    expect(screen.getByText(/Showing 1–10 of 12/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Next page'))
    expect(screen.getByText(/Showing 11–12 of 12/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsTab.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `src/renderer/src/components/ModelsPage/ModelsTab.tsx`**

```tsx
import { useMemo, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { buildModelRows, formatTokens, type ModelStatus } from '../../lib/modelRows'
import { Select, type SelectOption } from '../Select'
import { Toggle } from '../Toggle'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import { IconDots, IconSearch, IconStar } from '../icons'
import { ModelDetailModal } from './ModelDetailModal'
import './ModelsTab.css'

const STATUS_LABEL: Record<ModelStatus, string> = {
  available: 'Available',
  'not-configured': 'Provider not configured',
  unavailable: 'Unavailable'
}

const CAPABILITY_OPTIONS: SelectOption<
  'all' | 'functionCalling' | 'vision' | 'responseSchema' | 'reasoning' | 'webSearch'
>[] = [
  { value: 'all', label: 'All capabilities' },
  { value: 'functionCalling', label: 'Function calling' },
  { value: 'vision', label: 'Vision' },
  { value: 'responseSchema', label: 'Structured output' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'webSearch', label: 'Web search' }
]

const STATUS_OPTIONS: SelectOption<'all' | ModelStatus>[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'available', label: 'Available' },
  { value: 'not-configured', label: 'Not configured' },
  { value: 'unavailable', label: 'Unavailable' }
]

const PAGE_SIZE_OPTIONS: SelectOption<'10' | '25' | '50'>[] = [
  { value: '10', label: '10' },
  { value: '25', label: '25' },
  { value: '50', label: '50' }
]

export function ModelsTab(): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const openSettings = useAppStore((s) => s.openSettings)

  const [search, setSearch] = useState('')
  const [vendorFilter, setVendorFilter] = useState<'all' | ProviderId>('all')
  const [capabilityFilter, setCapabilityFilter] = useState<(typeof CAPABILITY_OPTIONS)[number]['value']>(
    'all'
  )
  const [statusFilter, setStatusFilter] = useState<'all' | ModelStatus>('all')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<'10' | '25' | '50'>('25')
  const [openRef, setOpenRef] = useState<string | null>(null)

  const vendorOptions: SelectOption<'all' | ProviderId>[] = [
    { value: 'all', label: 'All vendors' },
    ...manageableModels.map((p) => ({ value: p.id, label: p.displayName }))
  ]

  // The default-model box: the EFFECTIVE (enabled) model set across
  // providers, same source `Settings/pages/ModelsPage.tsx` used to use --
  // never the manageable (including-disabled) set.
  const defaultModelOptions: SelectOption<string>[] = [
    { value: '', label: 'Last used' },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.displayName}: ${m.label}` }))
    )
  ]

  const allRows = useMemo(
    () => (settings ? buildModelRows(manageableModels, providers, settings) : []),
    [manageableModels, providers, settings]
  )

  const filtered = allRows.filter((row) => {
    if (search.trim() && !row.label.toLowerCase().includes(search.trim().toLowerCase())) return false
    if (vendorFilter !== 'all' && row.providerId !== vendorFilter) return false
    if (capabilityFilter !== 'all' && !(row.metadata?.capabilities[capabilityFilter] ?? false))
      return false
    if (statusFilter !== 'all' && row.status !== statusFilter) return false
    if (enabledOnly && !row.enabled) return false
    return true
  })

  const size = Number(pageSize)
  const pageCount = Math.max(1, Math.ceil(filtered.length / size))
  const clampedPage = Math.min(page, pageCount)
  const start = (clampedPage - 1) * size
  const pageRows = filtered.slice(start, start + size)

  const toggleFavorite = (ref: string): void => {
    if (!settings) return
    const set = new Set(settings.favoriteModels ?? [])
    if (set.has(ref)) set.delete(ref)
    else set.add(ref)
    void saveSettings({ favoriteModels: [...set] })
  }

  if (!settings) return <EmptyState title="Loading models…" />

  return (
    <div className="models-tab">
      <div className="mt-toolbar">
        <Select
          ariaLabel="Default model"
          value={settings.defaultModelRef ?? ''}
          onChange={(v) => void saveSettings({ defaultModelRef: v || null })}
          options={defaultModelOptions}
          compact
        />
        <div className="mt-search">
          <IconSearch size={14} />
          <input
            placeholder="Search models…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <Select
          ariaLabel="Filter by vendor"
          value={vendorFilter}
          onChange={(v) => {
            setVendorFilter(v)
            setPage(1)
          }}
          options={vendorOptions}
          compact
        />
        <Select
          ariaLabel="Filter by capability"
          value={capabilityFilter}
          onChange={(v) => {
            setCapabilityFilter(v)
            setPage(1)
          }}
          options={CAPABILITY_OPTIONS}
          compact
        />
        <Select
          ariaLabel="Filter by status"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v)
            setPage(1)
          }}
          options={STATUS_OPTIONS}
          compact
        />
        <label className="mt-enabled-only">
          <Toggle
            checked={enabledOnly}
            ariaLabel="Show enabled only"
            onChange={(on) => {
              setEnabledOnly(on)
              setPage(1)
            }}
          />
          Show enabled only
        </label>
      </div>

      {pageRows.length === 0 ? (
        <EmptyState title="No models match these filters" />
      ) : (
        <table className="mt-table">
          <thead>
            <tr>
              <th aria-hidden="true" />
              <th>Model</th>
              <th>Context</th>
              <th>Capabilities</th>
              <th>Pricing</th>
              <th>Status</th>
              <th>Enabled</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const caps = row.metadata
                ? (Object.entries(row.metadata.capabilities) as [string, boolean][])
                    .filter(([, on]) => on)
                    .map(([k]) => k)
                : null
              return (
                <tr className="mt-row" key={row.ref}>
                  <td>
                    <button
                      type="button"
                      className={'mt-fav' + (row.favorite ? ' active' : '')}
                      aria-label={row.favorite ? `Unfavorite ${row.label}` : `Favorite ${row.label}`}
                      onClick={() => toggleFavorite(row.ref)}
                    >
                      <IconStar size={14} />
                    </button>
                  </td>
                  <td>
                    <div className="mt-model">
                      <ProviderIcon provider={row.providerId} size={16} />
                      <div>
                        <div className="mt-model-name">{row.label}</div>
                        <div className="mt-model-vendor">{row.providerDisplayName}</div>
                      </div>
                    </div>
                  </td>
                  <td>{formatTokens(row.contextWindow)}</td>
                  <td>
                    {caps === null ? (
                      <span className="mt-caps-unknown">Unknown</span>
                    ) : caps.length === 0 ? (
                      <span className="mt-caps-unknown">—</span>
                    ) : (
                      <div className="mt-caps">
                        {caps.slice(0, 3).map((c) => (
                          <span className="chip" key={c}>
                            {c}
                          </span>
                        ))}
                        {caps.length > 3 ? <span className="chip">+{caps.length - 3}</span> : null}
                      </div>
                    )}
                  </td>
                  <td>
                    {row.price ? (
                      <div className="mt-price">
                        <div>${row.price.inputPer1M} in</div>
                        <div>${row.price.outputPer1M} out</div>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className="mt-status">
                      <span
                        className={
                          'status-dot' +
                          (row.status === 'available'
                            ? ' ok'
                            : row.status === 'not-configured'
                              ? ' warn'
                              : ' err')
                        }
                      />
                      {STATUS_LABEL[row.status]}
                      {row.status !== 'available' ? (
                        <button
                          type="button"
                          className="mt-status-link"
                          onClick={() => openSettings('providers')}
                        >
                          {row.status === 'not-configured' ? 'Configure →' : 'Check status →'}
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <Toggle
                      checked={row.enabled}
                      ariaLabel={`${row.label} enabled`}
                      onChange={(on) => void setModelEnabled(row.ref, on)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mt-more"
                      aria-label="More actions"
                      onClick={() => setOpenRef(row.ref)}
                    >
                      <IconDots size={14} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="mt-pagination">
        <span>
          {filtered.length === 0
            ? 'Showing 0 of 0'
            : `Showing ${start + 1}–${Math.min(start + size, filtered.length)} of ${filtered.length}`}
        </span>
        <Select
          ariaLabel="Page size"
          value={pageSize}
          onChange={(v) => {
            setPageSize(v)
            setPage(1)
          }}
          options={PAGE_SIZE_OPTIONS}
          compact
        />
        <button
          type="button"
          aria-label="Previous page"
          disabled={clampedPage <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span className="mt-page-of">
          Page {clampedPage} of {pageCount}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={clampedPage >= pageCount}
          onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
        >
          Next
        </button>
      </div>

      {openRef ? <ModelDetailModal modelRef={openRef} onClose={() => setOpenRef(null)} /> : null}
    </div>
  )
}
```

- [ ] **Step 4: Add `ModelsTab.css`**

```css
.models-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mt-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mt-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border-soft);
  background: var(--bg-input);
  color: var(--text-dim);
}
.mt-search input {
  border: none;
  background: transparent;
  outline: none;
  color: var(--text);
  font-size: 13px;
  width: 180px;
}
.mt-enabled-only {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  margin-left: auto;
}
.mt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.mt-table th {
  text-align: left;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-dim);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-soft);
}
.mt-table td {
  padding: 10px;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: middle;
}
.mt-model {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mt-model-name {
  font-weight: 500;
  color: var(--text);
}
.mt-model-vendor {
  font-size: 11.5px;
  color: var(--text-dim);
}
.mt-caps {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.mt-caps-unknown {
  color: var(--text-dim);
  font-style: italic;
  font-size: 12px;
}
.mt-price {
  font-size: 12.5px;
  color: var(--text-dim);
}
.mt-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mt-status-link {
  border: none;
  background: transparent;
  color: var(--accent, var(--text));
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.mt-status-link:hover {
  text-decoration: underline;
}
.mt-fav,
.mt-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.mt-fav:hover,
.mt-more:hover {
  background: var(--wash);
  color: var(--text);
}
.mt-fav.active {
  color: var(--yellow, #e0b23e);
}
.mt-fav.active svg {
  fill: currentColor;
}
.mt-pagination {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.mt-pagination button {
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
.mt-pagination button:disabled {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsTab.test.tsx`
Expected: PASS, all 8 tests.

- [ ] **Step 6: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ModelsPage/ModelsTab.tsx src/renderer/src/components/ModelsPage/ModelsTab.css src/renderer/src/components/ModelsPage/ModelsTab.test.tsx
git commit -m "feat(models): add the Models tab data table with search/filters/pagination"
```

---

### Task 5: Add-custom-model modal + bulk actions (extends the Models tab)

**Files:**
- Create: `src/renderer/src/components/ModelsPage/AddCustomModelModal.tsx`
- Create: `src/renderer/src/components/ModelsPage/AddCustomModelModal.css`
- Create: `src/renderer/src/components/ModelsPage/AddCustomModelModal.test.tsx`
- Modify: `src/renderer/src/components/ModelsPage/ModelsTab.tsx`
- Modify: `src/renderer/src/components/ModelsPage/ModelsTab.css`
- Modify: `src/renderer/src/components/ModelsPage/ModelsTab.test.tsx`
- Modify: `src/renderer/src/components/Settings/Settings.css`

**Interfaces:**
- Consumes: store actions `addCustomModel`, `setModelEnabled`; `ADDABLE_PROVIDERS`-equivalent list (moved here from the old `Settings/pages/ModelsPage.tsx`); `Select`, `Menu`.
- Produces: `AddCustomModelModal({ onClose }): JSX.Element` (mounted by `ModelsTab` when its new "Add custom model" button is clicked); `ModelsTab` gains a footer row with that button and a "Bulk actions" menu offering "Enable filtered"/"Disable filtered" over the CURRENT filtered set (not just the current page).

- [ ] **Step 1: Write the failing test for `AddCustomModelModal`**

Create `src/renderer/src/components/ModelsPage/AddCustomModelModal.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { AddCustomModelModal } from './AddCustomModelModal'

describe('AddCustomModelModal', () => {
  it('disables Add until id, label, and a positive context window are filled', () => {
    useAppStore.setState({ manageableModels: [] } as never)
    render(<AddCustomModelModal onClose={vi.fn()} />)
    expect(screen.getByText('Add model')).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: 'my-model' } })
    fireEvent.change(screen.getByPlaceholderText(/display name/i), { target: { value: 'My Model' } })
    fireEvent.change(screen.getByPlaceholderText(/context window/i), { target: { value: '128000' } })
    expect(screen.getByText('Add model')).not.toBeDisabled()
  })

  it('calls addCustomModel with the trimmed draft and closes', () => {
    const addCustomModel = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    useAppStore.setState({ manageableModels: [], addCustomModel } as never)
    render(<AddCustomModelModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: '  my-model  ' } })
    fireEvent.change(screen.getByPlaceholderText(/display name/i), { target: { value: '  My Model  ' } })
    fireEvent.change(screen.getByPlaceholderText(/context window/i), { target: { value: '128000' } })
    fireEvent.click(screen.getByText('Add model'))
    expect(addCustomModel).toHaveBeenCalledWith({
      provider: 'anthropic',
      id: 'my-model',
      label: 'My Model',
      contextWindow: 128000
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('warns when the id collides with a curated model for the selected provider', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', custom: false, enabled: true }]
        }
      ]
    } as never)
    render(<AddCustomModelModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: 'claude-sonnet-5' } })
    expect(screen.getByText(/will override it/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/AddCustomModelModal.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `AddCustomModelModal.tsx`**

```tsx
import { useState } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import { useModalDialog } from '../../lib/useModalDialog'
import { Select, type SelectOption } from '../Select'
import { IconClose } from '../icons'
import './AddCustomModelModal.css'

// The six first-party providers a custom model can be added under (Ollama is
// dynamic/local and manages its own catalog) -- moved verbatim from the old
// Settings/pages/ModelsPage.tsx "Add a model" section.
const ADDABLE_PROVIDERS: SelectOption<ProviderId>[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'perplexity', label: 'Perplexity' },
  { value: 'xai', label: 'xAI' }
]

export function AddCustomModelModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const addCustomModel = useAppStore((s) => s.addCustomModel)
  const { mounted, state } = useAnimatedUnmount(true)
  const { ref: dialogRef, dialogProps } = useModalDialog(onClose)

  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [ctx, setCtx] = useState('')

  const ctxNum = Number(ctx)
  const valid = id.trim().length > 0 && label.trim().length > 0 && Number.isFinite(ctxNum) && ctxNum > 0
  const collides = manageableModels
    .find((p) => p.id === provider)
    ?.models.some((m) => !m.custom && m.id === id.trim())

  const submit = (): void => {
    if (!valid) return
    void addCustomModel({
      provider,
      id: id.trim(),
      label: label.trim(),
      contextWindow: Math.round(ctxNum)
    })
    onClose()
  }

  if (!mounted) return <></>

  return (
    <div
      className="modal-overlay open"
      data-state={state}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="add-model-panel"
        data-state={state}
        ref={dialogRef}
        {...dialogProps}
        aria-label="Add a custom model"
      >
        <div className="amp-head">
          <h3>Add a custom model</h3>
          <button type="button" className="amp-close" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="amp-body">
          <div className="amp-field">
            <label>Provider</label>
            <Select ariaLabel="Add model provider" value={provider} onChange={setProvider} options={ADDABLE_PROVIDERS} />
          </div>
          <div className="amp-field">
            <label>Model ID</label>
            <input
              className="set-input"
              placeholder="e.g. gemini-3.1-pro-preview"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="amp-field">
            <label>Display name</label>
            <input
              className="set-input"
              placeholder="e.g. Gemini 3.1 Pro"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="amp-field">
            <label>Context window (tokens)</label>
            <input
              className="set-input"
              type="number"
              min="1"
              placeholder="e.g. 1000000"
              value={ctx}
              onChange={(e) => setCtx(e.target.value)}
            />
          </div>
          {collides ? (
            <div className="amp-hint">
              A built-in model with this ID exists for {provider}; your custom entry will override it.
            </div>
          ) : null}
        </div>
        <div className="amp-footer">
          <button type="button" className="pill-btn" onClick={submit} disabled={!valid}>
            Add model
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add `AddCustomModelModal.css`**

```css
.add-model-panel {
  width: 420px;
  background: var(--bg-panel);
  border-radius: 14px;
  border: 1px solid var(--border-soft);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
}
.amp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border-soft);
}
.amp-head h3 {
  font-size: 14.5px;
  font-weight: 600;
  margin: 0;
}
.amp-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.amp-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.amp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.amp-field label {
  font-size: 12px;
  color: var(--text-dim);
}
.amp-hint {
  font-size: 12px;
  color: var(--yellow, #e0b23e);
}
.amp-footer {
  padding: 12px 18px 18px;
  display: flex;
  justify-content: flex-end;
}
```

Add `.add-model-panel` to the same `.settings-panel, .smithery-panel, .model-detail-panel` selector groups in `Settings.css` touched in Task 3 Step 4.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/AddCustomModelModal.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Write the failing test for `ModelsTab`'s new footer/bulk actions**

Append to `src/renderer/src/components/ModelsPage/ModelsTab.test.tsx` (inside the existing `describe('ModelsTab', ...)` block, using the same `seed()` helper already defined there):

```tsx
  it('opens the Add Custom Model modal from the footer button', () => {
    seed()
    render(<ModelsTab />)
    fireEvent.click(screen.getByText('Add custom model'))
    expect(screen.getByLabelText('Add a custom model')).toBeTruthy()
  })

  it('bulk-disables every FILTERED row (not just the current page) via Bulk actions', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    seed({ setModelEnabled })
    render(<ModelsTab />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'claude' } })
    fireEvent.click(screen.getByText('Bulk actions'))
    fireEvent.click(screen.getByText('Disable all filtered'))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-opus-4-8', false)
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-haiku-4-5', false)
    expect(setModelEnabled).not.toHaveBeenCalledWith('openai/gpt-5.6-sol', expect.anything())
  })
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsTab.test.tsx`
Expected: FAIL — no "Add custom model" button or "Bulk actions" menu exists yet.

- [ ] **Step 8: Wire both features into `ModelsTab.tsx`**

Add imports:

```ts
import { useRef } from 'react'
import { Menu } from '../ui/Menu'
import { AddCustomModelModal } from './AddCustomModelModal'
```

(merge `useRef` into the existing `import { useMemo, useState } from 'react'` line as `import { useMemo, useRef, useState } from 'react'`.)

Add state near the other `useState` calls:

```ts
const [addModelOpen, setAddModelOpen] = useState(false)
const [bulkOpen, setBulkOpen] = useState(false)
const bulkBtnRef = useRef<HTMLButtonElement>(null)
```

Add a bulk-action handler above the `return`:

```ts
const bulkSetEnabled = (enabled: boolean): void => {
  for (const row of filtered) void setModelEnabled(row.ref, enabled)
  setBulkOpen(false)
}
```

Add the Bulk actions button + menu at the end of `.mt-toolbar` (after the `mt-enabled-only` label):

```tsx
        <button ref={bulkBtnRef} type="button" className="mt-bulk-btn" onClick={() => setBulkOpen((o) => !o)}>
          Bulk actions
        </button>
        <Menu
          anchorRef={bulkBtnRef}
          open={bulkOpen}
          onClose={() => setBulkOpen(false)}
          groups={[
            {
              items: [
                { value: 'enable', label: 'Enable all filtered' },
                { value: 'disable', label: 'Disable all filtered' }
              ]
            }
          ]}
          onSelect={(v) => bulkSetEnabled(v === 'enable')}
          ariaLabel="Bulk actions"
          placement="bottom-end"
        />
```

Add a footer row after `.mt-pagination` and before the `{openRef ? ... }` line:

```tsx
      <div className="mt-footer">
        <button type="button" className="mt-add-model" onClick={() => setAddModelOpen(true)}>
          + Add custom model
        </button>
      </div>
```

And, alongside the existing `{openRef ? <ModelDetailModal .../> : null}` line, add:

```tsx
      {addModelOpen ? <AddCustomModelModal onClose={() => setAddModelOpen(false)} /> : null}
```

- [ ] **Step 9: Add the matching CSS to `ModelsTab.css`**

```css
.mt-bulk-btn {
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.mt-bulk-btn:hover {
  background: var(--wash);
}
.mt-footer {
  display: flex;
}
.mt-add-model {
  border: 1px dashed var(--border-soft);
  background: transparent;
  color: var(--text-dim);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.mt-add-model:hover {
  color: var(--text);
  border-color: var(--border);
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsTab.test.tsx src/renderer/src/components/ModelsPage/AddCustomModelModal.test.tsx`
Expected: PASS, all tests (the 7 from Task 4 + 2 new ones, + the 3 `AddCustomModelModal` tests).

- [ ] **Step 11: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/src/components/ModelsPage/AddCustomModelModal.tsx src/renderer/src/components/ModelsPage/AddCustomModelModal.css src/renderer/src/components/ModelsPage/AddCustomModelModal.test.tsx src/renderer/src/components/ModelsPage/ModelsTab.tsx src/renderer/src/components/ModelsPage/ModelsTab.css src/renderer/src/components/ModelsPage/ModelsTab.test.tsx src/renderer/src/components/Settings/Settings.css
git commit -m "feat(models): add custom-model modal and real bulk enable/disable actions"
```

---

### Task 6: Catalog tab

**Files:**
- Create: `src/renderer/src/components/ModelsPage/CatalogTab.tsx`
- Create: `src/renderer/src/components/ModelsPage/CatalogTab.css`
- Create: `src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`

**Interfaces:**
- Consumes: `buildModelRows` (Task 2); store slices `manageableModels`, `providers`, `settings` + action `setModelEnabled`; `ProviderIcon`, `EmptyState`.
- Produces: `CatalogTab(): JSX.Element` — Task 8's page shell renders this under the "Catalog" tab.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { CatalogTab } from './CatalogTab'

describe('CatalogTab', () => {
  it('shows only disabled models as cards with a description and an Enable button', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }
          ]
        }
      ],
      providers: [
        { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
      ],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] }
    } as never)
    render(<CatalogTab />)
    expect(screen.queryByText('Claude Opus 4.8')).toBeNull()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.getByText(/smallest, cheapest/)).toBeTruthy()
  })

  it('enables a model from its card', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }]
        }
      ],
      providers: [
        { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
      ],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] },
      setModelEnabled
    } as never)
    render(<CatalogTab />)
    fireEvent.click(screen.getByText('Enable'))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-haiku-4-5', true)
  })

  it('shows an empty state when every model is already enabled', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true }]
        }
      ],
      providers: [],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] }
    } as never)
    render(<CatalogTab />)
    expect(screen.getByText('All models are enabled')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `CatalogTab.tsx`**

```tsx
import { useAppStore } from '../../state/store'
import { buildModelRows } from '../../lib/modelRows'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import './CatalogTab.css'

// Discovery view: every currently-DISABLED model, one card each, so enabling a
// model is a browse-and-click action rather than hunting it down in the
// Models tab's table. Populated from the same buildModelRows join as every
// other Models-page surface, filtered to enabled === false.
export function CatalogTab(): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)

  if (!settings) return <EmptyState title="Loading models…" />

  const disabled = buildModelRows(manageableModels, providers, settings).filter((r) => !r.enabled)

  if (disabled.length === 0) {
    return (
      <EmptyState
        title="All models are enabled"
        hint="Disabled models you enable will disappear from this list."
      />
    )
  }

  return (
    <div className="catalog-tab">
      {disabled.map((row) => (
        <div className="ct-card" key={row.ref}>
          <div className="ct-card-head">
            <ProviderIcon provider={row.providerId} size={18} />
            <div className="ct-card-name">{row.label}</div>
          </div>
          <div className="ct-card-vendor">{row.providerDisplayName}</div>
          {row.catalog?.description ? <div className="ct-card-desc">{row.catalog.description}</div> : null}
          <button type="button" className="ct-enable" onClick={() => void setModelEnabled(row.ref, true)}>
            Enable
          </button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Add `CatalogTab.css`**

```css
.catalog-tab {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.ct-card {
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-card, var(--bg-panel));
}
.ct-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ct-card-name {
  font-weight: 500;
  font-size: 13.5px;
  color: var(--text);
}
.ct-card-vendor {
  font-size: 11.5px;
  color: var(--text-dim);
}
.ct-card-desc {
  font-size: 12.5px;
  color: var(--text-dim);
  line-height: 1.4;
  flex: 1;
}
.ct-enable {
  align-self: flex-start;
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12.5px;
  cursor: pointer;
  margin-top: 4px;
}
.ct-enable:hover {
  background: var(--wash);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ModelsPage/CatalogTab.tsx src/renderer/src/components/ModelsPage/CatalogTab.css src/renderer/src/components/ModelsPage/CatalogTab.test.tsx
git commit -m "feat(models): add the Catalog discovery tab"
```

---

### Task 7: Pricing tab

**Files:**
- Create: `src/renderer/src/components/ModelsPage/PricingTab.tsx`
- Create: `src/renderer/src/components/ModelsPage/PricingTab.css`
- Create: `src/renderer/src/components/ModelsPage/PricingTab.test.tsx`

**Interfaces:**
- Consumes: `buildModelRows` (Task 2); store slices `manageableModels`, `providers`, `settings` + action `syncPricing` (Task 1's widened return); `ErrorCard`, `relativeAge`.
- Produces: `PricingTab(): JSX.Element` — Task 8's page shell renders this under the "Pricing" tab. This replaces the old inline pricing table that lived at the bottom of `Settings/pages/ModelsPage.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ModelsPage/PricingTab.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { PricingTab } from './PricingTab'

function seed(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    manageableModels: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true }]
      }
    ],
    providers: [
      { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
    ],
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] },
    ...overrides
  } as never)
}

describe('PricingTab', () => {
  it('lists every model with its resolved price and source', () => {
    seed()
    render(<PricingTab />)
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getByText('$5')).toBeTruthy()
    expect(screen.getByText('$25')).toBeTruthy()
    expect(screen.getByText('default')).toBeTruthy()
  })

  it('runs a sync and shows the result', async () => {
    const syncPricing = vi
      .fn()
      .mockResolvedValue({ syncedCount: 3, metadataCount: 3, unmatched: [], syncedAt: Date.now() })
    seed({ syncPricing })
    render(<PricingTab />)
    fireEvent.click(screen.getByText('Sync prices'))
    await waitFor(() => expect(screen.getByText(/3 synced/)).toBeTruthy())
  })

  it('shows an error card when sync fails', async () => {
    const syncPricing = vi.fn().mockRejectedValue(new Error('offline'))
    seed({ syncPricing })
    render(<PricingTab />)
    fireEvent.click(screen.getByText('Sync prices'))
    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/PricingTab.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `PricingTab.tsx`**

```tsx
import { useState } from 'react'
import { useAppStore } from '../../state/store'
import { buildModelRows } from '../../lib/modelRows'
import { relativeAge } from '../../lib/time'
import { ErrorCard } from '../ui/ErrorCard'
import './PricingTab.css'

export function PricingTab(): React.JSX.Element | null {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const syncPricing = useAppStore((s) => s.syncPricing)

  const [sync, setSync] = useState<{ status: 'idle' | 'pending' | 'done' | 'error'; msg: string }>({
    status: 'idle',
    msg: ''
  })

  if (!settings) return null

  const rows = buildModelRows(manageableModels, providers, settings)

  const runSync = (): void => {
    setSync({ status: 'pending', msg: '' })
    void syncPricing()
      .then((r) => setSync({ status: 'done', msg: `${r.syncedCount} synced · ${r.unmatched.length} unmatched` }))
      .catch((e) => setSync({ status: 'error', msg: e instanceof Error ? e.message : 'Sync failed' }))
  }

  return (
    <div className="pricing-tab">
      <div className="pricing-intro">USD per 1M tokens. Sync pulls current prices from LiteLLM.</div>
      <table className="pricing-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ref}>
              <td className="pricing-model">{row.label}</td>
              <td>{row.price ? `$${row.price.inputPer1M}` : '—'}</td>
              <td>{row.price ? `$${row.price.outputPer1M}` : '—'}</td>
              <td>
                {row.priceSource ? (
                  <span className={'price-src ' + row.priceSource}>{row.priceSource}</span>
                ) : (
                  <span className="price-src none">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pricing-actions">
        <button className="pill-btn" onClick={runSync} disabled={sync.status === 'pending'}>
          {sync.status === 'pending' ? 'Syncing…' : 'Sync prices'}
        </button>
        {sync.status === 'done' ? <span className="pricing-result">{sync.msg}</span> : null}
      </div>
      {sync.status === 'error' ? (
        <div className="pricing-error">
          <ErrorCard>{sync.msg}</ErrorCard>
        </div>
      ) : null}
      <div className="pricing-synced">
        {settings.modelPricingSyncedAt ? `Last synced ${relativeAge(settings.modelPricingSyncedAt)}` : 'Using bundled defaults'}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add `PricingTab.css`**

The old `Settings/pages/ModelsPage.tsx`'s pricing markup relied on `.pricing-intro`/`.pricing-table`/`.pricing-model`/`.price-src`/`.pricing-actions`/`.pricing-result`/`.pricing-error`/`.pricing-synced`, all already defined in `Settings.css`. Create a near-empty `PricingTab.css` that only adds the outer wrapper spacing (everything else is inherited):

```css
.pricing-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/PricingTab.test.tsx`
Expected: PASS, all 3 tests. (The `$5`/`$25` bundled price for `anthropic/claude-opus-4-8` comes from `BUNDLED_PRICES` in `src/shared/pricing.ts`, already present — no fixture changes needed.)

- [ ] **Step 6: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ModelsPage/PricingTab.tsx src/renderer/src/components/ModelsPage/PricingTab.css src/renderer/src/components/ModelsPage/PricingTab.test.tsx
git commit -m "feat(models): add the Pricing tab"
```

---

### Task 8: Page assembly + top-level routing (remove Models from Settings)

**Files:**
- Create: `src/renderer/src/components/ModelsPage/ModelsPage.tsx`
- Create: `src/renderer/src/components/ModelsPage/ModelsPage.css`
- Create: `src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`
- Modify: `src/renderer/src/state/store.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Sidebar/Sidebar.tsx`
- Modify: `src/renderer/src/components/Settings/SettingsNav.ts`
- Modify: `src/renderer/src/components/Settings/SettingsModal.tsx`
- Modify: `src/renderer/src/components/Settings/SettingsModal.test.tsx`
- Delete: `src/renderer/src/components/Settings/pages/ModelsPage.tsx`
- Delete: `src/renderer/src/components/Settings/pages/ModelsPage.test.tsx`

**Interfaces:**
- Consumes: `ModelsTab`, `CatalogTab`, `PricingTab` (Tasks 4-7); `syncPricing` action (Task 1); the sidebar's existing `openProjectsIndex`/`{ kind: 'projects' }` pattern as the structural precedent.
- Produces: `openModelsPage(): void` store action + `{ kind: 'models' }` view; `ModelsPage(): JSX.Element` mounted by `App.tsx`; a "Models" `nav-item` in `Sidebar.tsx`.

- [ ] **Step 1: Write the failing test for the new page shell**

Create `src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { ModelsPage } from './ModelsPage'

function seed(): void {
  useAppStore.setState({
    manageableModels: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true }]
      }
    ],
    providers: [
      { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
    ],
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [], modelPricingSyncedAt: undefined }
  } as never)
}

describe('ModelsPage', () => {
  it('defaults to the Models tab', () => {
    seed()
    render(<ModelsPage />)
    expect(document.querySelector('.models-tab')).toBeTruthy()
  })

  it('switches to Catalog and Pricing tabs', () => {
    seed()
    render(<ModelsPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }))
    expect(document.querySelector('.catalog-tab')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Pricing' }))
    expect(document.querySelector('.pricing-tab')).toBeTruthy()
  })

  it('runs the header Sync metadata action', async () => {
    const syncPricing = vi
      .fn()
      .mockResolvedValue({ syncedCount: 1, metadataCount: 1, unmatched: [], syncedAt: Date.now() })
    seed()
    useAppStore.setState({ syncPricing } as never)
    render(<ModelsPage />)
    fireEvent.click(screen.getByText('Sync metadata'))
    await waitFor(() => expect(syncPricing).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `ModelsPage.tsx`**

```tsx
import { useState } from 'react'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { ModelsTab } from './ModelsTab'
import { CatalogTab } from './CatalogTab'
import { PricingTab } from './PricingTab'
import './ModelsPage.css'

type Tab = 'models' | 'catalog' | 'pricing'
const TABS: { id: Tab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'pricing', label: 'Pricing' }
]

export function ModelsPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const syncPricing = useAppStore((s) => s.syncPricing)
  const [tab, setTab] = useState<Tab>('models')
  const [pending, setPending] = useState(false)

  const runSync = (): void => {
    setPending(true)
    void syncPricing().finally(() => setPending(false))
  }

  return (
    <div className="models-page">
      <div className="mp-head">
        <div className="mp-headtext">
          <div className="page-title">Models</div>
          <div className="page-sub">
            Every model available to BearCode -- capabilities, pricing, and status in one place.
          </div>
        </div>
        <button type="button" className="pill-btn" onClick={runSync} disabled={pending}>
          {pending ? 'Syncing…' : 'Sync metadata'}
        </button>
        <span className="mp-synced">
          {settings?.modelPricingSyncedAt
            ? `Last synced ${relativeAge(settings.modelPricingSyncedAt)}`
            : 'Never synced'}
        </span>
      </div>

      <div className="mp-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={'mp-tab' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mp-body">
        {tab === 'models' ? <ModelsTab /> : null}
        {tab === 'catalog' ? <CatalogTab /> : null}
        {tab === 'pricing' ? <PricingTab /> : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add `ModelsPage.css`**

```css
.models-page {
  flex: 1;
  min-width: 0;
  background: var(--bg-window);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.mp-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 22px 28px 0;
}
.mp-headtext {
  flex: 1;
  min-width: 0;
}
.mp-synced {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}
.mp-tabs {
  display: flex;
  gap: 4px;
  padding: 18px 28px 0;
  border-bottom: 1px solid var(--border-soft);
}
.mp-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 500;
  padding: 8px 4px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-right: 18px;
}
.mp-tab:hover {
  color: var(--text);
}
.mp-tab.active {
  color: var(--text);
  border-bottom-color: var(--accent, var(--text));
}
.mp-body {
  padding: 20px 28px 28px;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Wire the `{ kind: 'models' }` view into `store.ts`**

In the `View` union (around line 83-89 of `src/renderer/src/state/store.ts`), add:

```ts
type View =
  | { kind: 'home' }
  | { kind: 'conversation'; id: string }
  | { kind: 'history' }
  | { kind: 'terminal'; path: string }
  | { kind: 'project'; path: string | null }
  | { kind: 'projects' }
  | { kind: 'models' }
```

Near the `openProjectsIndex(): void` declaration in the store's action-interface block (around line 394), add:

```ts
  openModelsPage(): void
```

Near the `openProjectsIndex` implementation (around line 916), add:

```ts
    openModelsPage: () => {
      set({ view: { kind: 'models' }, auxSelection: null, reviewFocusPath: null })
    },
```

- [ ] **Step 7: Wire routing into `App.tsx`**

Add the import alongside the existing `ProjectsIndex` import (around line 7):

```ts
import { ModelsPage } from './components/ModelsPage/ModelsPage'
```

Add the render branch alongside the existing `{view.kind === 'projects' ? <ProjectsIndex /> : null}` line (around line 157):

```tsx
          {view.kind === 'models' ? <ModelsPage /> : null}
```

- [ ] **Step 8: Add the "Models" nav-item to `Sidebar.tsx`**

Add `IconGrid` to the existing icons import (alongside `IconFolder`, around line 44):

```ts
  IconGrid,
```

Add an `openModelsPage` selector near the existing `openProjectsIndex` one (around line 80):

```ts
  const openModelsPage = useAppStore((s) => s.openModelsPage)
```

Immediately after the existing "Projects" nav-item block (around line 246, right before `<div className="sb-scroll">`), add:

```tsx
      {mode === 'hermes' && hermesEnabled ? null : (
        <button
          className={'nav-item' + (view.kind === 'models' ? ' selected' : '')}
          onClick={openModelsPage}
        >
          <IconGrid />
          Models
        </button>
      )}
```

- [ ] **Step 9: Remove Models from Settings**

In `src/renderer/src/components/Settings/SettingsNav.ts`:
- Remove `| 'models'` from the `SettingsPageId` union.
- Remove `{ id: 'models', label: 'Models', icon: 'IconGrid' },` from `SETTINGS_NAV`'s `'Settings'` group.

In `src/renderer/src/components/Settings/SettingsModal.tsx`:
- Remove `import { ModelsPage } from './pages/ModelsPage'`.
- Remove `{page === 'models' ? <ModelsPage /> : null}`.

Delete the files:

```bash
git rm src/renderer/src/components/Settings/pages/ModelsPage.tsx src/renderer/src/components/Settings/pages/ModelsPage.test.tsx
```

- [ ] **Step 10: Update `SettingsModal.test.tsx` for Models leaving the modal**

Remove the `it('Models page no longer shows the API-key inputs', ...)` test block (around line 119-124) — Models no longer renders inside `SettingsModal` at all, so this assertion is moot.

Remove `'Models',` from the two nav-label arrays that list every rail item (around lines 139 and 232) — the rail no longer has a Models entry.

Replace the `it('routes: Providers shows a key input, Models does not', ...)` test (around line 175-180) with a Models-free version asserting only the Providers behavior:

```tsx
  it('routes to Providers and shows a key input', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Providers'))
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeTruthy()
  })
```

Remove the entire pricing-table assertion block that previously clicked into the Models page (around line 335-350's `fireEvent.click(screen.getByText('Models'))` through the pricing assertions that follow it) — that coverage now lives in `PricingTab.test.tsx` (Task 7) and `ModelsTab.test.tsx` (Task 4), which already assert the same bundled-price/source behavior against the moved components.

- [ ] **Step 11: Run the full suite + both tsc gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, 0 failures, 0 TS errors. Confirm no remaining references to the deleted `Settings/pages/ModelsPage.tsx` anywhere: `grep -rn "pages/ModelsPage" src` should return nothing.

- [ ] **Step 12: Manual smoke check**

Start the dev app (`npm run dev`), click the new "Models" sidebar nav-item, confirm: the page renders with the sidebar still visible, all three tabs switch correctly, a row's ⋮ opens the detail modal, the modal's toggle/favorite/close all work, "Sync metadata" runs without error (or fails gracefully offline), and Settings' rail no longer shows a "Models" item.

- [ ] **Step 13: Commit**

```bash
git add src/renderer/src/components/ModelsPage/ModelsPage.tsx src/renderer/src/components/ModelsPage/ModelsPage.css src/renderer/src/components/ModelsPage/ModelsPage.test.tsx src/renderer/src/state/store.ts src/renderer/src/App.tsx src/renderer/src/components/Sidebar/Sidebar.tsx src/renderer/src/components/Settings/SettingsNav.ts src/renderer/src/components/Settings/SettingsModal.tsx src/renderer/src/components/Settings/SettingsModal.test.tsx
git commit -m "feat(models): move Models to a top-level page, remove it from Settings"
```
