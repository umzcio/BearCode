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
