import type {
  ManageableProvider,
  ProviderId,
  ProviderModels
} from '@shared/types'
import type {
  ModelMetadata,
  ModelMetadataMap,
  ModelMode,
  ModelPrice,
  PricingMap
} from '@shared/pricing'
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

export type CapabilityKey = 'functionCalling' | 'vision' | 'responseSchema' | 'reasoning' | 'webSearch'

// Shared human-readable labels for capability keys and model status, single
// source of truth for the table's chips/filter, the detail modal's capability
// grid, and its status row (previously three separate local copies, one of
// which rendered raw camelCase capability keys straight to users).
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  functionCalling: 'Function calling',
  vision: 'Vision',
  responseSchema: 'Structured output',
  reasoning: 'Reasoning',
  webSearch: 'Web search'
}

export const STATUS_LABEL: Record<ModelStatus, string> = {
  available: 'Available',
  'not-configured': 'Provider not configured',
  unavailable: 'Unavailable'
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
