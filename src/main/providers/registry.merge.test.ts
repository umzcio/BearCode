import { describe, it, expect } from 'vitest'
import { mergeModels } from './registry'
import type { CustomModel, ModelInfo } from '../../shared/types'

const curated: ModelInfo[] = [
  { id: 'a', label: 'A', contextWindow: 100 },
  { id: 'b', label: 'B', contextWindow: 200 }
]

describe('mergeModels', () => {
  it('returns curated unchanged with no custom/disabled', () => {
    expect(mergeModels('openai', curated, [], [])).toEqual(curated)
  })

  it('removes disabled by full ref', () => {
    expect(mergeModels('openai', curated, [], ['openai/a']).map((m) => m.id)).toEqual(['b'])
  })

  it('appends custom for this provider only', () => {
    const custom: CustomModel[] = [
      { provider: 'openai', id: 'c', label: 'C', contextWindow: 300 },
      { provider: 'google', id: 'd', label: 'D', contextWindow: 400 }
    ]
    expect(mergeModels('openai', curated, custom, []).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('custom wins on id collision (single entry, custom label/window)', () => {
    const custom: CustomModel[] = [{ provider: 'openai', id: 'a', label: 'A2', contextWindow: 999 }]
    const out = mergeModels('openai', curated, custom, [])
    expect(out).toHaveLength(2)
    expect(out.find((m) => m.id === 'a')).toEqual({ id: 'a', label: 'A2', contextWindow: 999 })
  })

  it('disabled also hides a custom model', () => {
    const custom: CustomModel[] = [{ provider: 'openai', id: 'c', label: 'C', contextWindow: 300 }]
    expect(mergeModels('openai', curated, custom, ['openai/c']).map((m) => m.id)).toEqual([
      'a',
      'b'
    ])
  })
})
