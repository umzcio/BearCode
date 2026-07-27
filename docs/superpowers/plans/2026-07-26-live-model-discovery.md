# Live Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static Anthropic/Google/OpenAI model lists in `registry.ts` with a live-preferred, static-fallback list, verified against each provider's real `list models` API, without touching xAI/Perplexity/OpenRouter (no viable discovery mechanism for any of them).

**Architecture:** A new `src/main/providers/liveDiscovery.ts` holds three pure fetch+parse functions (no BearCode-settings knowledge). `registry.ts` gains an in-memory, per-process cache (`liveModelCache`/`liveCapabilityCache`) and an idempotent `ensureLiveDiscovery(provider)` trigger that both `listAllModels()` (via `REGISTRY[i].listModels()`) and `listManageableModels()` call — whichever runs first warms the cache for the other. `contextWindowFor()` (the summarizer's synchronous mid-conversation lookup) reads the same cache read-only, never triggering a fetch itself. Live-discovered capability patches are never persisted to `AppSettings` — they're merged with LiteLLM's persisted `modelMetadata` at render time by the existing `buildModelRows` helper.

**Tech Stack:** No new dependencies — plain `fetch` with `AbortSignal.timeout`, matching the existing Ollama-discovery pattern already in `registry.ts`.

## Global Constraints

- **Fail closed, always.** No API key configured, or the live fetch errors/times out (5s) → fall back entirely to the static curated array. Never a hard failure, never an error the user has to notice or work around.
- **Per-field merge, uniformly.** Live wins wherever it has a signal (model list AND capabilities); LiteLLM (persisted) or the static array (model list only) fills whatever live doesn't cover. Applies identically to Anthropic, Google, and OpenAI — the amount each contributes differs, the rule doesn't.
- **`codeExecution` has no LiteLLM fallback at all** (verified live, 2026-07-26 — LiteLLM's closest flag, `supports_computer_use`, is a different tool). It is only ever knowable for Anthropic models, and only when Anthropic's live discovery has actually succeeded this session. Every other case (no key, Google, OpenAI, custom, Ollama) reads as unknown/`false` — document this in code, don't try to work around it.
- **`pdfInput` does have a LiteLLM fallback** (`supports_pdf_input`) — wire it in so it degrades gracefully everywhere live discovery doesn't reach.
- A model reference is always `${providerId}/${modelId}`. Live-discovered capability patches are cached keyed by bare model id inside `liveDiscovery.ts`'s return value; `registry.ts` is the only place that prefixes with `${provider}/`.
- OpenAI's live response has **no display name field** — for OpenAI only, prefer a matching static curated entry's `label` over the raw id on collision (the opposite of the general "live wins" rule, and deliberately so — a raw id is worse UX than a name that already exists).
- This repo has a pre-existing typecheck baseline (currently 14 `typecheck:node` / 2 `typecheck:web` errors, unrelated to this feature) — introduce zero new errors beyond it. Run `npm run typecheck` (not raw `tsc`, this repo's script passes `--composite false`).

---

### Task 1: Widen `ModelMetadata` with `codeExecution`/`pdfInput`, wire LiteLLM's `pdf_input`, add shared capability labels

**Files:**
- Modify: `src/shared/pricing.ts`
- Modify: `src/main/pricing/sync.ts`
- Modify: `src/main/pricing/sync.test.ts`
- Modify: `src/renderer/src/lib/modelRows.ts`
- Modify: `src/renderer/src/lib/modelRows.test.ts`

**Interfaces:**
- Produces: `ModelMetadata.capabilities` gains `codeExecution: boolean` and `pdfInput: boolean`; `CapabilityKey` (in `lib/modelRows.ts`) gains the two matching keys, and `CAPABILITY_LABEL` gains their labels. Because `ModelsTab.tsx`/`ModelDetailModal.tsx` already iterate `CAPABILITY_LABEL`/`row.metadata.capabilities` generically (verified: `Object.entries(CAPABILITY_LABEL)` for the filter dropdown and detail-modal grid, `Object.entries(row.metadata.capabilities)` for the table's chips), **no UI file needs to change** — the two new capabilities appear in the filter dropdown, the table's chips, and the detail modal automatically once this task lands.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test for the widened `ModelMetadata` shape**

In `src/main/pricing/sync.test.ts`, extend the existing fixture's `'claude-opus-4-8'` entry and add a new assertion (add these lines inside the existing `describe('parseLiteLLM', ...)` block, alongside the existing capability test):

```ts
  it('captures supports_pdf_input as pdfInput, and defaults codeExecution to false (no LiteLLM equivalent)', () => {
    const { metadata } = parseLiteLLM(
      {
        'claude-opus-4-8': {
          mode: 'chat',
          supports_pdf_input: true
        }
      },
      ['anthropic/claude-opus-4-8']
    )
    expect(metadata['anthropic/claude-opus-4-8']?.capabilities.pdfInput).toBe(true)
    expect(metadata['anthropic/claude-opus-4-8']?.capabilities.codeExecution).toBe(false)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/pricing/sync.test.ts`
Expected: FAIL — `supports_pdf_input` isn't parsed yet, and `capabilities.codeExecution`/`capabilities.pdfInput` don't exist on the type yet (TS error surfaces as a runtime `undefined` mismatch in the test).

- [ ] **Step 3: Widen `ModelMetadata` in `src/shared/pricing.ts`**

Find the `ModelMetadata` interface's `capabilities` block and replace it:

```ts
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
    // Verified live (2026-07-26): LiteLLM has no equivalent flag for this --
    // its closest concept, supports_computer_use, is Anthropic's separate
    // browser/screen-control tool, not the code-execution tool. This field
    // is therefore only ever knowable for Anthropic models, and only when
    // Anthropic's live model discovery has succeeded this session (see
    // src/main/providers/liveDiscovery.ts) -- every other case reads false.
    codeExecution: boolean
    pdfInput: boolean
  }
}
```

- [ ] **Step 4: Parse `supports_pdf_input` in `src/main/pricing/sync.ts`**

Add the field to `LiteLLMEntry`:

```ts
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
  supports_pdf_input?: boolean
}
```

Update `metadataFromEntry`:

```ts
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
      webSearch: entry.supports_web_search ?? false,
      codeExecution: false,
      pdfInput: entry.supports_pdf_input ?? false
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/pricing/sync.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 6: Write the failing test for the shared capability label additions**

In `src/renderer/src/lib/modelRows.test.ts`, add (near the existing capability-related tests, or as a new `describe`):

```ts
describe('CAPABILITY_LABEL', () => {
  it('has a human label for codeExecution and pdfInput', () => {
    expect(CAPABILITY_LABEL.codeExecution).toBe('Code execution')
    expect(CAPABILITY_LABEL.pdfInput).toBe('PDF input')
  })
})
```

Add `CAPABILITY_LABEL` to the file's existing import line from `./modelRows`.

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/modelRows.test.ts`
Expected: FAIL — `CAPABILITY_LABEL.codeExecution`/`.pdfInput` are `undefined`.

- [ ] **Step 8: Widen `CapabilityKey`/`CAPABILITY_LABEL` in `src/renderer/src/lib/modelRows.ts`**

Replace:

```ts
export type CapabilityKey = 'functionCalling' | 'vision' | 'responseSchema' | 'reasoning' | 'webSearch'
```

with:

```ts
export type CapabilityKey =
  | 'functionCalling'
  | 'vision'
  | 'responseSchema'
  | 'reasoning'
  | 'webSearch'
  | 'codeExecution'
  | 'pdfInput'
```

Replace:

```ts
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  functionCalling: 'Function calling',
  vision: 'Vision',
  responseSchema: 'Structured output',
  reasoning: 'Reasoning',
  webSearch: 'Web search'
}
```

with:

```ts
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  functionCalling: 'Function calling',
  vision: 'Vision',
  responseSchema: 'Structured output',
  reasoning: 'Reasoning',
  webSearch: 'Web search',
  codeExecution: 'Code execution',
  pdfInput: 'PDF input'
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/modelRows.test.ts`
Expected: PASS, all tests.

- [ ] **Step 10: Manual verification that no UI file needs changes**

Run `npm test -- ModelsTab ModelDetailModal` and confirm every existing test in both files still passes unchanged (they should — `ModelsTab.tsx`/`ModelDetailModal.tsx` both iterate `CAPABILITY_LABEL`/`row.metadata.capabilities` generically, so widening the shared map is the only change needed for the two new capabilities to appear in the filter dropdown, table chips, and detail-modal grid). Do not edit either file in this task.

- [ ] **Step 11: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors beyond the pre-existing baseline.

- [ ] **Step 12: Commit**

```bash
git add src/shared/pricing.ts src/main/pricing/sync.ts src/main/pricing/sync.test.ts src/renderer/src/lib/modelRows.ts src/renderer/src/lib/modelRows.test.ts
git commit -m "feat(models): add codeExecution/pdfInput capability fields"
```

---

### Task 2: Consolidate `MANAGEABLE`/`STATIC_MODELS` into a shared live-discovery-ready cache (behavior-preserving refactor)

**Files:**
- Modify: `src/main/providers/registry.ts`
- Modify: `src/main/providers/registry.settings.test.ts`

**Interfaces:**
- Produces: `knownModels(provider): ModelInfo[]` (sync, cache-or-static read), `liveCapabilitiesFor(ref): Partial<ModelMetadata['capabilities']> | undefined`, `clearLiveDiscoveryCache(): void`, an internal `ensureLiveDiscovery(provider): Promise<void>` (a no-op stub in this task — Task 6 fills in the real fetchers). `listManageableModels()` becomes `async` (no behavior change yet — it awaits the no-op stub, then reads exactly the same static data as before via `knownModels`).
- Consumes: `ModelMetadata` type from `@shared/pricing` (new import).

**This task must not change what any existing test observes.** Every currently-passing test in `registry.test.ts`, `registry.contextWindow.test.ts`, `registry.merge.test.ts`, `registry.settings.test.ts` must still pass unmodified except where `listManageableModels()`'s new `async` signature requires an `await`/`.resolves` addition at its call sites.

- [ ] **Step 1: Find and read every existing call site of `listManageableModels()`**

Run: `grep -rn "listManageableModels" src/main` — confirm the only real (non-test-mock) call site is `src/main/ipc.ts`'s `ipcMain.handle('bearcode:models:manageable', () => listManageableModels())`, which already works unchanged with an async handler (`ipcMain.handle` awaits whatever the callback returns, sync or async). No edit needed there. Every test-file reference is a `vi.mock(...)` stub (`listManageableModels: vi.fn()`), which stays compatible either way.

- [ ] **Step 2: Add the cache, `knownModels`, `liveCapabilitiesFor`, `clearLiveDiscoveryCache`, and the `ensureLiveDiscovery` stub**

Add near the top of `src/main/providers/registry.ts`, after the existing imports (widen the import line to add `ModelMetadata`):

```ts
import type { ModelMetadata } from '../../shared/pricing'
```

Add after the `STATIC_MODELS` constant (keep `STATIC_MODELS` exactly as it is — it becomes the fallback layer, not removed):

```ts
// Per-provider live-discovered model list (Anthropic/Google/OpenAI only --
// see liveDiscovery.ts), populated lazily by ensureLiveDiscovery(). Empty
// until that provider's first successful live fetch this process lifetime;
// knownModels() falls back to STATIC_MODELS for any provider with no cache
// entry -- every provider, until Task 6 wires in the real fetchers, and
// permanently for xAI/Perplexity/OpenRouter (no discovery mechanism exists).
const liveModelCache = new Map<ProviderId, ModelInfo[]>()

// Per-ref live-discovered capability patch. Merged on top of LiteLLM's
// persisted AppSettings.modelMetadata at render time by buildModelRows
// (Task 7) -- never itself persisted to settings.
const liveCapabilityCache = new Map<string, Partial<ModelMetadata['capabilities']>>()

// The current best-known model list for a provider: live-discovered if a
// successful fetch has landed this process lifetime, else the static
// curated array. Synchronous and side-effect-free -- never triggers a
// fetch itself (that's ensureLiveDiscovery's job) -- safe to call from a
// hot path like contextWindowFor.
export function knownModels(provider: ProviderId): ModelInfo[] {
  return liveModelCache.get(provider) ?? STATIC_MODELS[provider] ?? []
}

export function liveCapabilitiesFor(ref: string): Partial<ModelMetadata['capabilities']> | undefined {
  return liveCapabilityCache.get(ref)
}

// Sync-metadata button (Models page header) calls this alongside its
// existing LiteLLM sync, so one action refreshes everything about a
// model's data. Clearing (rather than a "force" flag on
// ensureLiveDiscovery) is enough: the guard below is just "does this
// provider have a cache entry," and clearing removes it, making the next
// natural call re-fetch.
export function clearLiveDiscoveryCache(): void {
  liveModelCache.clear()
  liveCapabilityCache.clear()
}

// Idempotent per-provider live-discovery trigger. Whichever of
// listAllModels() (via REGISTRY[i].listModels()) or listManageableModels()
// runs first pays the network cost and warms the caches above for the
// rest of the process; every later call this session is a no-op (the
// guard is cache presence, not a separate "already tried" flag -- see
// clearLiveDiscoveryCache's comment for why a failed/no-key attempt is
// allowed to retry on the next call rather than being cached as a
// permanent negative result). This stub intentionally does nothing yet --
// Task 6 replaces the body with real per-provider fetchers from
// liveDiscovery.ts. Behavior today is identical to before this task:
// knownModels() falls back to STATIC_MODELS for every provider.
async function ensureLiveDiscovery(_provider: ProviderId): Promise<void> {
  // no-op until Task 6
}
```

- [ ] **Step 3: Replace `MANAGEABLE` with a plain id list, and update every reader to use `knownModels`**

Replace:

```ts
// The first-party curated providers subject to opt-out + Add-model. Ollama is
// excluded: it is fully dynamic/local and manages its own catalog.
const MANAGEABLE: { id: ProviderId; models: ModelInfo[] }[] = [
  { id: 'anthropic', models: ANTHROPIC_MODELS },
  { id: 'openai', models: OPENAI_MODELS },
  { id: 'google', models: GOOGLE_MODELS },
  { id: 'openrouter', models: OPENROUTER_MODELS },
  { id: 'perplexity', models: PERPLEXITY_MODELS },
  { id: 'xai', models: XAI_MODELS }
]
```

with:

```ts
// The first-party curated providers subject to opt-out + Add-model. Ollama is
// excluded: it is fully dynamic/local and manages its own catalog. Anthropic/
// Google/OpenAI's entries in knownModels() may be live-discovered (Task 6);
// openrouter/perplexity/xai always resolve to their static array (no
// discovery mechanism exists for any of them).
const MANAGEABLE_PROVIDER_IDS: ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'perplexity',
  'xai'
]
```

Replace `allKnownModelRefs`:

```ts
export function allKnownModelRefs(): string[] {
  const { customModels = [], disabledModels = [] } = getSettings()
  return MANAGEABLE_PROVIDER_IDS.flatMap((id) =>
    mergeModels(id, knownModels(id), customModels, disabledModels).map((m) => `${id}/${m.id}`)
  )
}
```

Replace `listManageableModels`:

```ts
// The Models settings page's management list: curated/live + custom per
// first-party provider, INCLUDING disabled models (with an `enabled` flag)
// so the user can toggle them back on. Distinct from listAllModels, which
// returns only the visible/effective set for the pickers. Async since Task
// 6 has this trigger live discovery for anthropic/google/openai the first
// time it (or listAllModels) is called this process lifetime.
export async function listManageableModels(): Promise<ManageableProvider[]> {
  await Promise.all(
    (['anthropic', 'google', 'openai'] as ProviderId[]).map((id) => ensureLiveDiscovery(id))
  )
  const { customModels = [], disabledModels = [] } = getSettings()
  const disabledSet = new Set(disabledModels)
  return MANAGEABLE_PROVIDER_IDS.map((id) => {
    const entry = getProvider(id)
    const models = knownModels(id)
    const byId = new Map<string, ManageableModel>()
    for (const m of models) {
      const ref = `${id}/${m.id}`
      const liveCapabilities = liveCapabilitiesFor(ref)
      byId.set(m.id, {
        id: m.id,
        label: m.label,
        contextWindow: m.contextWindow,
        custom: false,
        enabled: !disabledSet.has(ref),
        ...(liveCapabilities ? { liveCapabilities } : {})
      })
    }
    for (const c of customModels) {
      if (c.provider === id) {
        byId.set(c.id, {
          id: c.id,
          label: c.label,
          contextWindow: c.contextWindow,
          custom: true,
          enabled: !disabledSet.has(`${id}/${c.id}`)
        })
      }
    }
    return { id, displayName: entry.displayName, color: entry.color, models: [...byId.values()] }
  })
}
```

(`ManageableModel.liveCapabilities` doesn't exist on the type yet — Step 4 adds it.)

- [ ] **Step 4: Add `liveCapabilities` to `ManageableModel` in `src/shared/types.ts`**

Widen the existing pricing import at the top of the file (it currently reads `import type { ModelMetadataMap, PricingMap } from './pricing'` after Task 1 of the original Models-page plan — confirm the exact current line by reading the file, then add `ModelMetadata`):

```ts
import type { ModelMetadata, ModelMetadataMap, PricingMap } from './pricing'
```

Add the field to `ManageableModel` (after `enabled: boolean`):

```ts
export interface ManageableModel {
  id: string
  label: string
  contextWindow?: number
  custom: boolean // user-added (removable) vs curated (toggle-only)
  enabled: boolean // false when its ref is in disabledModels
  // Live-discovered capability data (Anthropic/Google only, this session) --
  // NOT persisted to AppSettings; overlaid on top of LiteLLM's persisted
  // modelMetadata by buildModelRows (Task 7). Absent for every model until a
  // provider's live discovery succeeds at least once this process lifetime.
  liveCapabilities?: Partial<ModelMetadata['capabilities']>
}
```

- [ ] **Step 5: Update `REGISTRY`'s anthropic/openai/google entries and `contextWindowFor`**

Replace the three entries' `listModels`:

```ts
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    color: '#d97757',
    requiresKey: true,
    listModels: async () => {
      await ensureLiveDiscovery('anthropic')
      return { models: knownModels('anthropic'), reachable: true }
    }
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    color: '#9ad0b7',
    requiresKey: true,
    listModels: async () => {
      await ensureLiveDiscovery('openai')
      return { models: knownModels('openai'), reachable: true }
    }
  },
  {
    id: 'google',
    displayName: 'Google',
    color: '#4c8dff',
    requiresKey: true,
    listModels: async () => {
      await ensureLiveDiscovery('google')
      return { models: knownModels('google'), reachable: true }
    }
  },
```

(openrouter/perplexity/xai/ollama entries are unchanged.)

Update `contextWindowFor`:

```ts
export function contextWindowFor(ref: string): number | null {
  const { provider, modelId } = parseModelRef(ref)
  // A custom model wins on id collision (F7 invariant, matching mergeModels): the
  // user may deliberately override a curated id with a smaller window (a lower-
  // tier deployment). Check custom FIRST so the summarizer compacts against the
  // real window, not the curated one.
  const custom = (getSettings().customModels ?? []).find(
    (c) => c.provider === provider && c.id === modelId
  )
  if (custom) return custom.contextWindow
  const info = knownModels(provider).find((m) => m.id === modelId)
  return info?.contextWindow ?? null
}
```

- [ ] **Step 6: Update `registry.settings.test.ts` if needed**

Read the current file. Its `contextWindowFor` assertions (e.g. `contextWindowFor('anthropic/claude-opus-4-8')` toBe `1_000_000`) should pass unchanged, since `knownModels('anthropic')` falls back to `STATIC_MODELS.anthropic` (`ANTHROPIC_MODELS`) with the cache empty — identical data to before. If any test calls `listManageableModels()` directly (not just `contextWindowFor`/`allKnownModelRefs`), add `await`/`.resolves` as needed. Run the file first to confirm before editing anything.

- [ ] **Step 7: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors. This step is the actual proof that the refactor is behavior-preserving — the entire existing suite (2940+ tests) must be green with no test content changes beyond any `await` additions from Step 6.

- [ ] **Step 8: Commit**

```bash
git add src/main/providers/registry.ts src/main/providers/registry.settings.test.ts src/shared/types.ts
git commit -m "refactor(models): consolidate static model lists behind a live-discovery-ready cache"
```

---

### Task 3: Anthropic live-discovery fetcher

**Files:**
- Create: `src/main/providers/liveDiscovery.ts`
- Create: `src/main/providers/liveDiscovery.test.ts`

**Interfaces:**
- Produces: `LiveDiscoveryResult { models: ModelInfo[]; capabilities: Record<string, Partial<ModelMetadata['capabilities']>> }` (capabilities keyed by bare model id, NOT a full ref — `registry.ts`, in Task 6, does the `${provider}/` prefixing), `fetchAnthropicModels(apiKey: string): Promise<LiveDiscoveryResult | null>` (`null` on any failure — network error, timeout, non-2xx — never throws).
- Consumes: `ModelInfo` (`@shared/types`), `ModelMetadata` (`@shared/pricing`).

- [ ] **Step 1: Write the failing test**

Create `src/main/providers/liveDiscovery.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAnthropicModels } from './liveDiscovery'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(body)
  }) as unknown as typeof fetch
}

describe('fetchAnthropicModels', () => {
  it('maps id/display_name/max_input_tokens and the covered capability flags', async () => {
    mockFetchOnce({
      data: [
        {
          id: 'claude-opus-4-8',
          display_name: 'Claude Opus 4.8',
          max_input_tokens: 1_000_000,
          capabilities: {
            image_input: { supported: true },
            structured_outputs: { supported: true },
            thinking: { supported: false },
            code_execution: { supported: true },
            pdf_input: { supported: true }
          }
        }
      ],
      has_more: false,
      last_id: 'claude-opus-4-8'
    })
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.models).toEqual([
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 }
    ])
    expect(result?.capabilities['claude-opus-4-8']).toEqual({
      vision: true,
      responseSchema: true,
      reasoning: false,
      codeExecution: true,
      pdfInput: true
    })
  })

  it('treats a 0 max_input_tokens as unknown, not a real context window', async () => {
    mockFetchOnce({
      data: [{ id: 'x', display_name: 'X', max_input_tokens: 0 }],
      has_more: false,
      last_id: 'x'
    })
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.models[0].contextWindow).toBeUndefined()
  })

  it('follows has_more/last_id pagination across multiple pages', async () => {
    let call = 0
    global.fetch = vi.fn().mockImplementation(() => {
      call++
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: 'a', display_name: 'A' }],
              has_more: true,
              last_id: 'a'
            })
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: 'b', display_name: 'B' }], has_more: false, last_id: 'b' })
      })
    }) as unknown as typeof fetch
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(call).toBe(2)
  })

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce({}, false)
    expect(await fetchAnthropicModels('sk-test')).toBeNull()
  })

  it('returns null when fetch throws (network error/timeout)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch
    expect(await fetchAnthropicModels('sk-test')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers/liveDiscovery.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Create `src/main/providers/liveDiscovery.ts`**

```ts
// Live model-list discovery for the providers whose APIs actually expose one
// (verified against live docs, 2026-07-26). Pure fetch+parse -- no BearCode
// settings/ref-format knowledge lives here; registry.ts owns caching, ref
// prefixing, and the static-array fallback.
import type { ModelInfo } from '../../shared/types'
import type { ModelMetadata } from '../../shared/pricing'

export interface LiveDiscoveryResult {
  models: ModelInfo[]
  // Keyed by the provider's BARE model id (not a "provider/id" ref) --
  // registry.ts prefixes when populating its cache.
  capabilities: Record<string, Partial<ModelMetadata['capabilities']>>
}

const FETCH_TIMEOUT_MS = 5000
// Anthropic's default page size is 20 and BearCode only needs a small set of
// Claude chat models, but bound the pagination loop against a malformed or
// unexpectedly large response rather than looping unboundedly.
const MAX_PAGES = 5

interface AnthropicModelEntry {
  id: string
  display_name: string
  max_input_tokens?: number
  capabilities?: {
    image_input?: { supported?: boolean }
    structured_outputs?: { supported?: boolean }
    thinking?: { supported?: boolean }
    code_execution?: { supported?: boolean }
    pdf_input?: { supported?: boolean }
  }
}
interface AnthropicModelsResponse {
  data: AnthropicModelEntry[]
  has_more: boolean
  last_id: string
}

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_API_VERSION = '2023-06-01'

export async function fetchAnthropicModels(apiKey: string): Promise<LiveDiscoveryResult | null> {
  try {
    const models: ModelInfo[] = []
    const capabilities: Record<string, Partial<ModelMetadata['capabilities']>> = {}
    let afterId: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(ANTHROPIC_MODELS_URL)
      if (afterId) url.searchParams.set('after_id', afterId)
      const res = await fetch(url, {
        headers: { 'anthropic-version': ANTHROPIC_API_VERSION, 'X-Api-Key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const body = (await res.json()) as AnthropicModelsResponse
      for (const entry of body.data) {
        models.push({
          id: entry.id,
          label: entry.display_name,
          ...(entry.max_input_tokens ? { contextWindow: entry.max_input_tokens } : {})
        })
        if (entry.capabilities) {
          const c = entry.capabilities
          capabilities[entry.id] = {
            vision: c.image_input?.supported ?? false,
            responseSchema: c.structured_outputs?.supported ?? false,
            reasoning: c.thinking?.supported ?? false,
            codeExecution: c.code_execution?.supported ?? false,
            pdfInput: c.pdf_input?.supported ?? false
          }
        }
      }
      if (!body.has_more) break
      afterId = body.last_id
    }
    return { models, capabilities }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers/liveDiscovery.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/liveDiscovery.ts src/main/providers/liveDiscovery.test.ts
git commit -m "feat(models): add Anthropic live model-list discovery"
```

---

### Task 4: Google live-discovery fetcher

**Files:**
- Modify: `src/main/providers/liveDiscovery.ts`
- Modify: `src/main/providers/liveDiscovery.test.ts`

**Interfaces:**
- Produces: `fetchGoogleModels(apiKey: string): Promise<LiveDiscoveryResult | null>`.
- Consumes: nothing new — same `LiveDiscoveryResult` shape as Task 3.

- [ ] **Step 1: Write the failing test**

Append to `src/main/providers/liveDiscovery.test.ts` (new `describe` block, using the same `mockFetchOnce` helper already defined there):

```ts
describe('fetchGoogleModels', () => {
  it('strips the models/ prefix, maps displayName/inputTokenLimit, and the thinking flag', async () => {
    mockFetchOnce({
      models: [
        {
          name: 'models/gemini-3.1-pro-preview',
          displayName: 'Gemini 3.1 Pro',
          inputTokenLimit: 1_000_000,
          thinking: true
        }
      ]
    })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models).toEqual([
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000 }
    ])
    expect(result?.capabilities['gemini-3.1-pro-preview']).toEqual({ reasoning: true })
  })

  it('falls back to the stripped id as label when displayName is absent', async () => {
    mockFetchOnce({ models: [{ name: 'models/some-new-model' }] })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models[0]).toEqual({ id: 'some-new-model', label: 'some-new-model' })
  })

  it('follows nextPageToken pagination', async () => {
    let call = 0
    global.fetch = vi.fn().mockImplementation(() => {
      call++
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ models: [{ name: 'models/a' }], nextPageToken: 'page2' })
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [{ name: 'models/b' }] }) })
    }) as unknown as typeof fetch
    const result = await fetchGoogleModels('key-test')
    expect(result?.models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(call).toBe(2)
  })

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce({}, false)
    expect(await fetchGoogleModels('key-test')).toBeNull()
  })
})
```

Add `fetchGoogleModels` to the file's import line from `./liveDiscovery`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers/liveDiscovery.test.ts`
Expected: FAIL — `fetchGoogleModels` doesn't exist yet.

- [ ] **Step 3: Add `fetchGoogleModels` to `src/main/providers/liveDiscovery.ts`**

```ts
interface GoogleModelEntry {
  name: string
  displayName?: string
  inputTokenLimit?: number
  thinking?: boolean
}
interface GoogleModelsResponse {
  models?: GoogleModelEntry[]
  nextPageToken?: string
}

const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

export async function fetchGoogleModels(apiKey: string): Promise<LiveDiscoveryResult | null> {
  try {
    const models: ModelInfo[] = []
    const capabilities: Record<string, Partial<ModelMetadata['capabilities']>> = {}
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(GOOGLE_MODELS_URL)
      url.searchParams.set('pageSize', '50')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const res = await fetch(url, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const body = (await res.json()) as GoogleModelsResponse
      for (const entry of body.models ?? []) {
        const id = entry.name.replace(/^models\//, '')
        models.push({
          id,
          label: entry.displayName ?? id,
          ...(entry.inputTokenLimit ? { contextWindow: entry.inputTokenLimit } : {})
        })
        if (entry.thinking != null) {
          capabilities[id] = { reasoning: entry.thinking }
        }
      }
      if (!body.nextPageToken) break
      pageToken = body.nextPageToken
    }
    return { models, capabilities }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers/liveDiscovery.test.ts`
Expected: PASS, all tests (5 from Task 3 + 4 new).

- [ ] **Step 5: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/liveDiscovery.ts src/main/providers/liveDiscovery.test.ts
git commit -m "feat(models): add Google live model-list discovery"
```

---

### Task 5: OpenAI live-discovery fetcher + chat-model filtering

**Files:**
- Modify: `src/main/providers/liveDiscovery.ts`
- Modify: `src/main/providers/liveDiscovery.test.ts`

**Interfaces:**
- Produces: `fetchOpenAIModels(apiKey: string, isKnownChatModel: (id: string) => boolean): Promise<LiveDiscoveryResult | null>`. The filter predicate is injected by the caller (Task 6, in `registry.ts`) rather than implemented here — this file stays free of BearCode-settings knowledge (the LiteLLM cross-reference lives in `registry.ts`, not here).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/main/providers/liveDiscovery.test.ts`:

```ts
describe('fetchOpenAIModels', () => {
  it('filters ids through the injected predicate and labels each by its raw id', async () => {
    mockFetchOnce({
      data: [{ id: 'gpt-5.6-sol' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }]
    })
    const result = await fetchOpenAIModels('sk-test', (id) => id.startsWith('gpt-'))
    expect(result?.models).toEqual([{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }])
    expect(result?.capabilities).toEqual({})
  })

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce({}, false)
    expect(await fetchOpenAIModels('sk-test', () => true)).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch
    expect(await fetchOpenAIModels('sk-test', () => true)).toBeNull()
  })
})
```

Add `fetchOpenAIModels` to the file's import line from `./liveDiscovery`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers/liveDiscovery.test.ts`
Expected: FAIL — `fetchOpenAIModels` doesn't exist yet.

- [ ] **Step 3: Add `fetchOpenAIModels` to `src/main/providers/liveDiscovery.ts`**

```ts
interface OpenAIModelEntry {
  id: string
}
interface OpenAIModelsResponse {
  data: OpenAIModelEntry[]
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'

// OpenAI's list response has no display name and no capability/type field at
// all -- it mixes chat models with embeddings/whisper/tts/dall-e/moderation/
// fine-tunes. The caller (registry.ts) supplies the filter, since deciding
// "is this a chat model" is BearCode-settings-shaped logic (a LiteLLM
// cross-reference, with a hardcoded bootstrap fallback), not something this
// pure fetch/parse layer should know about.
export async function fetchOpenAIModels(
  apiKey: string,
  isKnownChatModel: (id: string) => boolean
): Promise<LiveDiscoveryResult | null> {
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const body = (await res.json()) as OpenAIModelsResponse
    const models: ModelInfo[] = body.data
      .filter((entry) => isKnownChatModel(entry.id))
      .map((entry) => ({ id: entry.id, label: entry.id }))
    return { models, capabilities: {} }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers/liveDiscovery.test.ts`
Expected: PASS, all tests (9 from Tasks 3-4 + 3 new).

- [ ] **Step 5: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/liveDiscovery.ts src/main/providers/liveDiscovery.test.ts
git commit -m "feat(models): add OpenAI live model-list discovery with chat-model filtering"
```

---

### Task 6: Wire the three fetchers into `registry.ts`'s live-discovery trigger

**Files:**
- Modify: `src/main/providers/registry.ts`
- Modify: `src/main/providers/registry.liveDiscovery.test.ts` (new)

**Interfaces:**
- Consumes: `fetchAnthropicModels`/`fetchGoogleModels`/`fetchOpenAIModels` (Tasks 3-5, `./liveDiscovery`); `getKey` (`../keys`).
- Produces: `ensureLiveDiscovery`'s real implementation (replacing Task 2's no-op stub) — this is the task where live discovery actually starts happening. `knownModels(provider)`/`liveCapabilitiesFor(ref)` (Task 2) now return real live data once a key is configured and a fetch succeeds.

- [ ] **Step 1: Write the failing test**

Create `src/main/providers/registry.liveDiscovery.test.ts`. This mocks `./liveDiscovery` and `../keys` at the module level (vitest's `vi.mock`), so it tests `ensureLiveDiscovery`'s orchestration logic in isolation from real network calls (Tasks 3-5 already covered the fetchers themselves against mocked `fetch`).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchAnthropicModels = vi.fn()
const fetchGoogleModels = vi.fn()
const fetchOpenAIModels = vi.fn()
vi.mock('./liveDiscovery', () => ({
  fetchAnthropicModels: (...args: unknown[]) => fetchAnthropicModels(...args),
  fetchGoogleModels: (...args: unknown[]) => fetchGoogleModels(...args),
  fetchOpenAIModels: (...args: unknown[]) => fetchOpenAIModels(...args)
}))

const getKey = vi.fn()
vi.mock('../keys', () => ({
  getKey: (...args: unknown[]) => getKey(...args),
  keyStatus: () => ({
    anthropic: true,
    openai: true,
    google: true,
    openrouter: true,
    perplexity: true,
    xai: true,
    ollama: true
  })
}))

vi.mock('../settings', () => ({
  getSettings: () => ({ customModels: [], disabledModels: [], modelMetadata: {} })
}))

describe('registry live discovery orchestration', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchAnthropicModels.mockReset()
    fetchGoogleModels.mockReset()
    fetchOpenAIModels.mockReset()
    getKey.mockReset()
  })

  it('falls back to the static array when no key is configured (never calls fetch)', async () => {
    getKey.mockReturnValue(undefined)
    const { knownModels, listManageableModels, ANTHROPIC_MODELS } = await import('./registry')
    await listManageableModels()
    expect(fetchAnthropicModels).not.toHaveBeenCalled()
    expect(knownModels('anthropic')).toEqual(ANTHROPIC_MODELS)
  })

  it('merges a successful live fetch into knownModels, live wins on collision', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({
      models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (live)', contextWindow: 999 }],
      capabilities: { 'claude-opus-4-8': { vision: true } }
    })
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue(null)
    const { knownModels, liveCapabilitiesFor, listManageableModels } = await import('./registry')
    await listManageableModels()
    const anthropic = knownModels('anthropic')
    expect(anthropic.find((m) => m.id === 'claude-opus-4-8')?.label).toBe('Claude Opus 4.8 (live)')
    expect(liveCapabilitiesFor('anthropic/claude-opus-4-8')).toEqual({ vision: true })
  })

  it('prefers the static curated label for OpenAI on id collision (no display name live)', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue(null)
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue({
      models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }],
      capabilities: {}
    })
    const { knownModels, listManageableModels } = await import('./registry')
    await listManageableModels()
    expect(knownModels('openai').find((m) => m.id === 'gpt-5.6-sol')?.label).toBe('GPT-5.6 Sol')
  })

  it('is idempotent: a second call does not re-fetch once the cache is warm', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchGoogleModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchOpenAIModels.mockResolvedValue({ models: [], capabilities: {} })
    const { listManageableModels } = await import('./registry')
    await listManageableModels()
    await listManageableModels()
    expect(fetchAnthropicModels).toHaveBeenCalledTimes(1)
  })

  it('clearLiveDiscoveryCache lets the next call re-fetch', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchGoogleModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchOpenAIModels.mockResolvedValue({ models: [], capabilities: {} })
    const { listManageableModels, clearLiveDiscoveryCache } = await import('./registry')
    await listManageableModels()
    clearLiveDiscoveryCache()
    await listManageableModels()
    expect(fetchAnthropicModels).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers/registry.liveDiscovery.test.ts`
Expected: FAIL — `ensureLiveDiscovery` is still Task 2's no-op stub, so live data never lands.

- [ ] **Step 3: Implement `ensureLiveDiscovery` for real in `src/main/providers/registry.ts`**

Add the import:

```ts
import { fetchAnthropicModels, fetchGoogleModels, fetchOpenAIModels } from './liveDiscovery'
import { getKey } from '../keys'
```

(`keyStatus` is already imported from `../keys` — add `getKey` alongside it in the same import statement.)

Add a merge helper and the OpenAI chat-model predicate above `ensureLiveDiscovery`:

```ts
// Merge a live-discovered list with the static curated array by id. For
// Anthropic/Google, live wins outright on collision (their APIs return a
// real display name). For OpenAI specifically, prefer the STATIC entry's
// label on collision -- OpenAI's list endpoint has no display-name field at
// all, so a raw id ("gpt-5.6-sol") is worse UX than a name we already have.
function mergeLiveWithStatic(
  live: ModelInfo[],
  staticModels: ModelInfo[],
  opts: { preferStaticLabel: boolean }
): ModelInfo[] {
  const staticById = new Map(staticModels.map((m) => [m.id, m]))
  const byId = new Map<string, ModelInfo>()
  for (const m of staticModels) byId.set(m.id, m)
  for (const m of live) {
    const existing = staticById.get(m.id)
    byId.set(m.id, {
      ...m,
      label: opts.preferStaticLabel && existing ? existing.label : m.label
    })
  }
  return [...byId.values()]
}

// OpenAI's list has no mode/type field, so filter via the LiteLLM catalog
// this feature already syncs (mode === 'chat'). Bootstrap fallback only for
// the case LiteLLM hasn't been synced yet (nothing to cross-reference) --
// a known-imperfect substring blacklist, superseded automatically the first
// time the user hits "Sync metadata".
const OPENAI_NON_CHAT_SUBSTRINGS = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'davinci-002',
  'babbage-002',
  'realtime',
  'audio',
  'image',
  'video',
  'computer-use',
  'codex'
]

function isKnownOpenAIChatModel(id: string, metadata: Record<string, { mode?: string }> | undefined): boolean {
  const ref = `openai/${id}`
  if (metadata?.[ref]) return metadata[ref].mode === 'chat'
  return !OPENAI_NON_CHAT_SUBSTRINGS.some((s) => id.includes(s))
}
```

Replace the `ensureLiveDiscovery` stub:

```ts
async function ensureLiveDiscovery(provider: ProviderId): Promise<void> {
  if (liveModelCache.has(provider)) return
  const apiKey = getKey(provider)
  if (!apiKey) return

  let result: Awaited<ReturnType<typeof fetchAnthropicModels>> = null
  if (provider === 'anthropic') result = await fetchAnthropicModels(apiKey)
  else if (provider === 'google') result = await fetchGoogleModels(apiKey)
  else if (provider === 'openai') {
    const metadata = getSettings().modelMetadata
    result = await fetchOpenAIModels(apiKey, (id) => isKnownOpenAIChatModel(id, metadata))
  }
  if (!result) return

  const merged = mergeLiveWithStatic(result.models, STATIC_MODELS[provider] ?? [], {
    preferStaticLabel: provider === 'openai'
  })
  liveModelCache.set(provider, merged)
  for (const [id, caps] of Object.entries(result.capabilities)) {
    liveCapabilityCache.set(`${provider}/${id}`, caps)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers/registry.liveDiscovery.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors. Pay particular attention to `registry.test.ts`/`registry.settings.test.ts`/`registry.contextWindow.test.ts` — none of them configure a key in their test settings mocks, so `getKey` should return `undefined` for all of them and every assertion should still resolve to the exact static-array behavior as before.

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/registry.ts src/main/providers/registry.liveDiscovery.test.ts
git commit -m "feat(models): wire live discovery into the shared model-list cache"
```

---

### Task 7: Merge live-discovered capabilities into `buildModelRows`

**Files:**
- Modify: `src/renderer/src/lib/modelRows.ts`
- Modify: `src/renderer/src/lib/modelRows.test.ts`

**Interfaces:**
- Consumes: `ManageableModel.liveCapabilities` (Task 2).
- Produces: `buildModelRows`'s `metadata` field now reflects the per-field merge (live wins where present, LiteLLM fills the rest) described in the spec.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/lib/modelRows.test.ts`, inside the existing `describe('buildModelRows', ...)` block:

```ts
  it('overlays live-discovered capabilities on top of LiteLLM metadata, per field', () => {
    const rows = buildModelRows(
      [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-opus-4-8',
              label: 'Claude Opus 4.8',
              custom: false,
              enabled: true,
              liveCapabilities: { vision: true, codeExecution: true }
            }
          ]
        }
      ],
      providers,
      {
        modelMetadata: {
          'anthropic/claude-opus-4-8': {
            mode: 'chat',
            capabilities: {
              functionCalling: true,
              vision: false,
              responseSchema: false,
              reasoning: false,
              webSearch: true,
              codeExecution: false,
              pdfInput: false
            }
          }
        }
      }
    )
    expect(rows[0].metadata?.capabilities).toEqual({
      functionCalling: true, // from LiteLLM, no live signal for this field
      vision: true, // live wins over LiteLLM's false
      responseSchema: false,
      reasoning: false,
      webSearch: true, // from LiteLLM, no live signal for this field
      codeExecution: true, // live only (LiteLLM never has this field)
      pdfInput: false
    })
  })

  it('builds a real metadata object from a live capability patch alone, when LiteLLM has no entry', () => {
    const rows = buildModelRows(
      [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-new-model',
              label: 'Claude New Model',
              custom: false,
              enabled: true,
              liveCapabilities: { vision: true }
            }
          ]
        }
      ],
      providers,
      {}
    )
    expect(rows[0].metadata).toEqual({
      mode: 'other',
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      capabilities: {
        functionCalling: false,
        vision: true,
        responseSchema: false,
        reasoning: false,
        webSearch: false,
        codeExecution: false,
        pdfInput: false
      }
    })
  })
```

(This reuses the file's existing `providers` fixture already defined earlier in the same `describe` block, per the pattern already used by the file's other `buildModelRows` tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/modelRows.test.ts`
Expected: FAIL — `buildModelRows` doesn't read `m.liveCapabilities` yet, and today's code returns `null` when there's no LiteLLM entry regardless of a live patch.

- [ ] **Step 3: Update `buildModelRows` in `src/renderer/src/lib/modelRows.ts`**

Replace the row-construction body's `metadata` line:

```ts
        metadata: settings.modelMetadata?.[ref] ?? null,
```

with a per-field merge:

```ts
        metadata: mergeMetadata(settings.modelMetadata?.[ref], m.liveCapabilities),
```

Add the merge helper above `buildModelRows`:

```ts
// Per-field merge: live-discovered capabilities (Anthropic/Google, this
// session only -- see src/main/providers/liveDiscovery.ts) win wherever they
// have a signal; LiteLLM's persisted data fills every field live doesn't
// cover. If there's neither a LiteLLM entry nor a live patch, the row's
// metadata stays null (today's "fully unknown" state, unchanged). If there's
// a live patch but no LiteLLM entry (a brand-new model LiteLLM hasn't
// catalogued yet), a real metadata object is still built from the patch
// alone, with every uncovered field defaulting to false/unknown -- same
// shape contract either way.
function mergeMetadata(
  base: ModelMetadata | undefined,
  live: Partial<ModelMetadata['capabilities']> | undefined
): ModelMetadata | null {
  if (!base && !live) return null
  return {
    mode: base?.mode ?? 'other',
    maxInputTokens: base?.maxInputTokens,
    maxOutputTokens: base?.maxOutputTokens,
    capabilities: {
      functionCalling: live?.functionCalling ?? base?.capabilities.functionCalling ?? false,
      vision: live?.vision ?? base?.capabilities.vision ?? false,
      responseSchema: live?.responseSchema ?? base?.capabilities.responseSchema ?? false,
      reasoning: live?.reasoning ?? base?.capabilities.reasoning ?? false,
      webSearch: live?.webSearch ?? base?.capabilities.webSearch ?? false,
      codeExecution: live?.codeExecution ?? base?.capabilities.codeExecution ?? false,
      pdfInput: live?.pdfInput ?? base?.capabilities.pdfInput ?? false
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/modelRows.test.ts`
Expected: PASS, all tests (previous + 2 new).

- [ ] **Step 5: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/modelRows.ts src/renderer/src/lib/modelRows.test.ts
git commit -m "feat(models): merge live-discovered capabilities into buildModelRows"
```

---

### Task 8: "Sync metadata" also refreshes live discovery

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/src/state/store.ts`
- Modify: `src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`

**Interfaces:**
- Consumes: `clearLiveDiscoveryCache` (Task 2, `./providers/registry`).
- Produces: the existing `bearcode:pricing:sync` handler also clears the live-discovery cache; the existing `syncPricing()` store action also refreshes `providers`/`manageableModels` afterward, so the renderer actually sees the newly-discovered models (clearing a main-process-only cache does nothing to already-fetched renderer state on its own).

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/components/ModelsPage/ModelsPage.test.tsx` (inside the existing `describe('ModelsPage', ...)` block):

```tsx
  it('refreshes providers and manageableModels after a successful metadata sync', async () => {
    const syncPricing = vi
      .fn()
      .mockResolvedValue({ syncedCount: 1, metadataCount: 1, unmatched: [], syncedAt: Date.now() })
    const refreshProviders = vi.fn().mockResolvedValue(undefined)
    const refreshManageableModels = vi.fn().mockResolvedValue(undefined)
    seed()
    useAppStore.setState({ syncPricing, refreshProviders, refreshManageableModels } as never)
    render(<ModelsPage />)
    fireEvent.click(screen.getByText('Sync metadata'))
    await waitFor(() => expect(refreshProviders).toHaveBeenCalled())
    expect(refreshManageableModels).toHaveBeenCalled()
  })
```

This asserts on the STORE action's own behavior (which Step 3 below changes), not `ModelsPage.tsx` directly — but it's the simplest place to exercise the click path end-to-end, matching the file's existing "runs the header Sync metadata action" test's shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`
Expected: FAIL — today's `syncPricing` store action doesn't call `refreshProviders`/`refreshManageableModels`.

- [ ] **Step 3: Update the `syncPricing` store action in `src/renderer/src/state/store.ts`**

Replace:

```ts
    syncPricing: async () => {
      // Main fetches + persists the prices; re-fetch settings so the freshly
      // synced modelPricing/modelPricingSyncedAt land in the store.
      const result = await window.bearcode.pricing.sync()
      const settings = await window.bearcode.settings.get()
      set({ settings })
      return result
    },
```

with:

```ts
    syncPricing: async () => {
      // Main fetches + persists the prices (and clears its live-discovery
      // cache -- see registry.ts's clearLiveDiscoveryCache); re-fetch
      // settings so the freshly synced modelPricing/modelMetadata land in
      // the store, then refresh providers/manageableModels so any
      // newly-discovered live models actually appear -- clearing a
      // main-process-only cache does nothing to already-fetched renderer
      // state on its own.
      const result = await window.bearcode.pricing.sync()
      const settings = await window.bearcode.settings.get()
      set({ settings })
      await get().refreshProviders()
      await get().refreshManageableModels()
      return result
    },
```

- [ ] **Step 4: Update the `bearcode:pricing:sync` IPC handler in `src/main/ipc.ts`**

Add the import (widen the existing `./providers/registry` import line):

```ts
import { allKnownModelRefs, clearLiveDiscoveryCache, listAllModels, listManageableModels } from './providers/registry'
```

Update the handler:

```ts
  ipcMain.handle('bearcode:pricing:sync', async () => {
    const refs = allKnownModelRefs()
    const { prices, metadata, unmatched } = await syncPricing(refs)
    const syncedAt = Date.now()
    setSettings({ modelPricing: prices, modelMetadata: metadata, modelPricingSyncedAt: syncedAt })
    clearLiveDiscoveryCache()
    return {
      syncedCount: Object.keys(prices).length,
      metadataCount: Object.keys(metadata).length,
      unmatched,
      syncedAt
    }
  })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/ModelsPage.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full suite + both tsc gates**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures, 0 new TS errors.

- [ ] **Step 7: Manual smoke check**

Start the dev app (`npm run dev`), open Settings > Providers and confirm an Anthropic/Google/OpenAI key is configured (or add one), navigate to the Models page, click "Sync metadata," and confirm the table doesn't error and (if any live-only models exist beyond the curated set) they appear after the sync completes. This is a real network call to each configured provider — offline/no-key should degrade silently to the static list per the fail-closed constraint, not error.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc.ts src/renderer/src/state/store.ts src/renderer/src/components/ModelsPage/ModelsPage.test.tsx
git commit -m "feat(models): refresh live discovery from the Sync metadata action"
```
