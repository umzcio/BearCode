# Live-Discovered Models Default Disabled Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only BearCode's curated models default to enabled. A model that exists only because live discovery found it defaults to disabled (opt-in), and Catalog switches from a card grid to a compact vendor-grouped row-list so a long disabled list stays scannable.

**Architecture:** A new opt-in settings list (`enabledLiveModels`) parallels the existing opt-out `disabledModels` list. `ManageableModel` gains a `liveOnly` flag (main process already knows whether an id is in `STATIC_MODELS[provider]`). `listManageableModels()`'s `enabled` computation branches on that flag. `setModelEnabled` branches which list it writes to, so every existing UI call site (Models tab toggle, Catalog's Enable button, detail modal toggle) needs zero changes. `CatalogTab` is rewritten from cards to grouped rows.

**Tech Stack:** No new dependencies.

## Global Constraints

- Curated and custom models' enabled/disabled semantics are UNCHANGED — this only adds a new default for the live-only case.
- `liveOnly` is true only for a model id present in a provider's live-discovered list but absent from that provider's `STATIC_MODELS` array. Never true for custom models (they have their own `custom: true` tracking already).
- New settings field is optional & additive, commented the same way every existing optional field is.
- Reuse existing `EmptyState`/`ProviderIcon` in the CatalogTab rewrite — don't invent new primitives for the row layout.

---

### Task 1: `enabledLiveModels` setting + `liveOnly` flag + main-process enabled computation

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/providers/registry.ts`
- Modify: `src/main/providers/registry.liveDiscovery.test.ts`

**Interfaces:**
- Produces: `AppSettings.enabledLiveModels?: string[]`; `ManageableModel.liveOnly: boolean`.

- [ ] **Step 1: Add the setting field to `src/shared/types.ts`**

Immediately after the existing `favoriteModels?: string[]` field, add:

```ts
  // Opt-IN allowlist for models that exist only because live discovery found
  // them (registry.ts's liveOnly flag) -- parallel to disabledModels, which
  // stays an opt-OUT list for curated/custom models. Optional & additive:
  // settings persisted before this feature coerce to [].
  enabledLiveModels?: string[]
```

Add `liveOnly: boolean` to `ManageableModel`, after `enabled: boolean`:

```ts
  // True only when this model exists in a provider's live-discovered list but
  // NOT in that provider's curated STATIC_MODELS array (registry.ts). Never
  // true for custom models. Drives the opt-in-vs-opt-out enabled default in
  // listManageableModels().
  liveOnly: boolean
```

- [ ] **Step 2: Write the failing test**

Add to `src/main/providers/registry.liveDiscovery.test.ts` (reusing its existing mocks for `./liveDiscovery`/`../keys`/`../settings` — read the file first to match its exact mock shapes):

```ts
  it('a live-only model defaults to disabled; opting in via enabledLiveModels enables it', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({
      models: [{ id: 'claude-new-model', label: 'Claude New Model' }],
      capabilities: {}
    })
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue(null)
    const { listManageableModels } = await import('./registry')
    const providers = await listManageableModels()
    const anthropic = providers.find((p) => p.id === 'anthropic')!
    const row = anthropic.models.find((m) => m.id === 'claude-new-model')!
    expect(row.liveOnly).toBe(true)
    expect(row.enabled).toBe(false)
  })

  it('a curated model is liveOnly: false and stays enabled by default', async () => {
    getKey.mockReturnValue(undefined)
    const { listManageableModels } = await import('./registry')
    const providers = await listManageableModels()
    const anthropic = providers.find((p) => p.id === 'anthropic')!
    const opus = anthropic.models.find((m) => m.id === 'claude-opus-4-8')!
    expect(opus.liveOnly).toBe(false)
    expect(opus.enabled).toBe(true)
  })
```

(Update the mock for `../settings` in this file's `vi.mock` to also return `enabledLiveModels: []` by default, so the new field is present in the mocked `getSettings()` shape.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/providers/registry.liveDiscovery.test.ts`
Expected: FAIL — `liveOnly` doesn't exist yet, and a live-only model currently defaults to `enabled: true`.

- [ ] **Step 4: Implement in `src/main/providers/registry.ts`**

In `listManageableModels()`, change the `customModels`/`disabledModels` destructure to also pull `enabledLiveModels`:

```ts
  const { customModels = [], disabledModels = [], enabledLiveModels = [] } = getSettings()
  const disabledSet = new Set(disabledModels)
  const enabledLiveSet = new Set(enabledLiveModels)
```

In the loop that builds each curated model's `ManageableModel` entry (the `for (const m of models)` loop inside the `MANAGEABLE_PROVIDER_IDS.map(...)` body), compute `liveOnly` per model and branch `enabled`:

```ts
    const staticIds = new Set((STATIC_MODELS[id] ?? []).map((sm) => sm.id))
    for (const m of models) {
      const ref = `${id}/${m.id}`
      const liveOnly = !staticIds.has(m.id)
      const liveCapabilities = liveCapabilitiesFor(ref)
      byId.set(m.id, {
        id: m.id,
        label: m.label,
        contextWindow: m.contextWindow,
        custom: false,
        liveOnly,
        enabled: liveOnly ? enabledLiveSet.has(ref) : !disabledSet.has(ref),
        ...(liveCapabilities ? { liveCapabilities } : {})
      })
    }
```

Custom models' entry (the `for (const c of customModels)` loop) gets `liveOnly: false` added alongside its existing fields (unchanged `enabled: !disabledSet.has(...)`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/providers/registry.liveDiscovery.test.ts`
Expected: PASS, all tests (previous + 2 new).

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures beyond the known pre-existing `memory/index.test.ts` failure, 0 new TS errors beyond the 14/2 baseline.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/providers/registry.ts src/main/providers/registry.liveDiscovery.test.ts
git commit -m "feat(models): live-discovered-only models default to disabled"
```

---

### Task 2: `setModelEnabled` branches between `disabledModels`/`enabledLiveModels`

**Files:**
- Modify: `src/renderer/src/state/store.ts`
- Modify: `src/renderer/src/state/store.test.ts`

**Interfaces:**
- Consumes: `ManageableModel.liveOnly` (Task 1).
- Produces: `setModelEnabled(ref, enabled)` writes to the correct list transparently — no call-site changes anywhere (Models tab toggle, Catalog Enable button, detail modal toggle all already just call this action).

- [ ] **Step 1: Write the failing test**

Read the current `setModelEnabled` test coverage in `store.test.ts` first (search for `setModelEnabled`) to match its existing mock/setup conventions, then add:

```ts
  it('setModelEnabled writes to enabledLiveModels (not disabledModels) for a liveOnly model', async () => {
    useAppStore.setState({
      settings: { disabledModels: [], enabledLiveModels: [] } as never,
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-new-model', label: 'Claude New Model', custom: false, enabled: false, liveOnly: true }]
        }
      ] as never
    })
    const setSpy = vi.fn().mockResolvedValue({ disabledModels: [], enabledLiveModels: ['anthropic/claude-new-model'] })
    useAppStore.setState({ /* mock window.bearcode.settings.set via existing file convention */ } as never)
    await useAppStore.getState().setModelEnabled('anthropic/claude-new-model', true)
    // Assert against whatever this file's existing window.bearcode mock convention captures
    // (read the file first -- match its established pattern for asserting IPC call args).
  })
```

(This step's exact test body depends on `store.test.ts`'s existing `window.bearcode` mocking convention — read the file first and write a test that follows it precisely rather than inventing a new mocking style. The assertion that matters: for a `liveOnly: true` model, the settings patch sent to `window.bearcode.settings.set` includes an updated `enabledLiveModels` array containing the ref, and does NOT touch `disabledModels`. For a `liveOnly: false` model, confirm the existing behavior — it patches `disabledModels`, not `enabledLiveModels` — is unchanged.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/state/store.test.ts`
Expected: FAIL — today's `setModelEnabled` always writes `disabledModels` regardless of `liveOnly`.

- [ ] **Step 3: Update `setModelEnabled` in `src/renderer/src/state/store.ts`**

Read the current implementation first (it currently computes a new `disabledModels` array and calls `saveSettings`/`window.bearcode.settings.set` with it, then calls `refreshManageableModels()`). Change it to look up the ref's `liveOnly` flag from `get().manageableModels` and branch which field it patches:

```ts
    setModelEnabled: async (ref, enabled) => {
      const s = get().settings
      if (!s) return
      const [providerId, ...rest] = ref.split('/')
      const modelId = rest.join('/')
      const provider = get().manageableModels.find((p) => p.id === providerId)
      const model = provider?.models.find((m) => m.id === modelId)
      if (model?.liveOnly) {
        const cur = s.enabledLiveModels ?? []
        const enabledLiveModels = enabled ? [...new Set([...cur, ref])] : cur.filter((r) => r !== ref)
        await window.bearcode.settings.set({ enabledLiveModels })
      } else {
        const cur = s.disabledModels ?? []
        const disabledModels = enabled ? cur.filter((r) => r !== ref) : [...new Set([...cur, ref])]
        await window.bearcode.settings.set({ disabledModels })
      }
      const settings = await window.bearcode.settings.get()
      set({ settings })
      await get().refreshManageableModels()
    },
```

(Match this against the file's actual current structure/naming before editing — the brief describes the intended shape, but the real file's exact statements around `saveSettings`/`window.bearcode.settings.set` may differ slightly; preserve whatever surrounding behavior isn't being changed, like the `refreshManageableModels()` call at the end.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/state/store.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures beyond the known baseline, 0 new TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts
git commit -m "feat(models): setModelEnabled writes to the right list for liveOnly models"
```

---

### Task 3: Catalog row-list grouped by vendor

**Files:**
- Modify: `src/renderer/src/components/ModelsPage/CatalogTab.tsx`
- Modify: `src/renderer/src/components/ModelsPage/CatalogTab.css`
- Modify: `src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`

**Interfaces:**
- No new props/exports — same `CatalogTab(): JSX.Element` component, same data source (`buildModelRows` filtered to `!enabled`).

- [ ] **Step 1: Write the failing test**

Read the current `CatalogTab.test.tsx` first, then update/add cases so the file asserts on the new structure: a vendor section header per distinct `providerDisplayName` present among disabled models, rows (not cards) under each, each row still showing name/description/Enable and still calling `setModelEnabled(ref, true)`. Add a case with disabled models from 2 different providers, asserting both vendor headers render and each model appears under the correct one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`
Expected: FAIL — current markup has no vendor grouping/headers.

- [ ] **Step 3: Rewrite `CatalogTab.tsx`**

```tsx
import { useAppStore } from '../../state/store'
import { buildModelRows, type ModelRow } from '../../lib/modelRows'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import './CatalogTab.css'

// Discovery view: every currently-DISABLED model, grouped by vendor as a
// compact row-list (not cards -- once live-only models default to disabled,
// this list is routinely dozens of models long, and a card grid doesn't
// scale; rows match the density the Models tab's table already uses).
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

  const groups = new Map<string, ModelRow[]>()
  for (const row of disabled) {
    const list = groups.get(row.providerDisplayName) ?? []
    list.push(row)
    groups.set(row.providerDisplayName, list)
  }

  return (
    <div className="catalog-tab">
      {[...groups.entries()].map(([vendor, rows]) => (
        <div className="ct-group" key={vendor}>
          <div className="ct-group-head">{vendor}</div>
          {rows.map((row) => (
            <div className="ct-row" key={row.ref}>
              <ProviderIcon provider={row.providerId} size={16} />
              <div className="ct-row-text">
                <span className="ct-row-name">{row.label}</span>
                {row.catalog?.description ? (
                  <span className="ct-row-desc">{row.catalog.description}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="ct-enable"
                onClick={() => void setModelEnabled(row.ref, true)}
              >
                Enable
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Rewrite `CatalogTab.css`**

```css
.catalog-tab {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.ct-group {
  display: flex;
  flex-direction: column;
}
.ct-group-head {
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-dim);
  padding: 4px 0 8px;
}
.ct-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--border-soft);
}
.ct-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  overflow: hidden;
}
.ct-row-name {
  font-weight: 500;
  font-size: 13.5px;
  color: var(--text);
  flex-shrink: 0;
}
.ct-row-desc {
  font-size: 12.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-enable {
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12.5px;
  cursor: pointer;
  flex-shrink: 0;
}
.ct-enable:hover {
  background: var(--wash);
}
```

(Delete the old `.ct-card`/`.ct-card-head`/`.ct-card-name`/`.ct-card-vendor`/`.ct-card-desc` rules entirely — nothing else uses them.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/components/ModelsPage/CatalogTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 new failures beyond baseline, 0 new TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ModelsPage/CatalogTab.tsx src/renderer/src/components/ModelsPage/CatalogTab.css src/renderer/src/components/ModelsPage/CatalogTab.test.tsx
git commit -m "feat(models): redesign Catalog as a vendor-grouped row-list"
```
