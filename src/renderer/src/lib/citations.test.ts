import { describe, it, expect } from 'vitest'
import { remapCitations } from './citations'

const CITES = [
  { url: 'https://one.example', title: 'One' },
  { url: 'https://two.example', title: 'Two' },
  { url: 'https://three.example', title: 'Three' },
  { url: 'https://four.example', title: 'Four' }
]

describe('remapCitations', () => {
  it('keeps only cited sources, ordered by first appearance, renumbered 1..k', () => {
    const { ordered, renumber } = remapCitations(['A claim.[3][2] More.[3] End.[1]'], CITES)
    expect(ordered.map((c) => c.title)).toEqual(['Three', 'Two', 'One'])
    expect(renumber.get(3)).toBe(1)
    expect(renumber.get(2)).toBe(2)
    expect(renumber.get(1)).toBe(3)
    expect(renumber.has(4)).toBe(false)
  })

  it('scans across multiple text blocks in order', () => {
    const { ordered } = remapCitations(['First.[2]', 'Second.[4]'], CITES)
    expect(ordered.map((c) => c.title)).toEqual(['Two', 'Four'])
  })

  it('ignores out-of-range markers', () => {
    const { ordered, renumber } = remapCitations(['Bogus.[9] Real.[1]'], CITES)
    expect(ordered.map((c) => c.title)).toEqual(['One'])
    expect(renumber.has(9)).toBe(false)
  })

  it('falls back to the full original list when no markers are present', () => {
    const { ordered, renumber } = remapCitations(['No markers at all.'], CITES)
    expect(ordered).toEqual(CITES)
    expect(renumber.size).toBe(0)
  })
})
