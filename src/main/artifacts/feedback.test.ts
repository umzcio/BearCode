import { describe, it, expect } from 'vitest'
import type { ArtifactComment } from '../../shared/types'
import { renderPlanFeedback } from './feedback'

const comment = (over: Partial<ArtifactComment> = {}): ArtifactComment => ({
  id: 'c1',
  artifactId: 'a1',
  quote: 'Step 2: rewrite the config',
  body: 'Extend it instead of rewriting.',
  createdAt: 1,
  sentAt: null,
  ...over
})

describe('renderPlanFeedback (comments + message -> markdown quotes, design 3.6)', () => {
  it('renders a quoted comment as a blockquote followed by the body', () => {
    expect(renderPlanFeedback([comment()])).toBe(
      '> Step 2: rewrite the config\n\nExtend it instead of rewriting.'
    )
  })
  it('prefixes EVERY line of a multi-line quote', () => {
    expect(renderPlanFeedback([comment({ quote: 'line one\nline two' })])).toBe(
      '> line one\n> line two\n\nExtend it instead of rewriting.'
    )
  })
  it('renders a quoteless comment as its body alone', () => {
    expect(renderPlanFeedback([comment({ quote: null, body: 'General note.' })])).toBe(
      'General note.'
    )
  })
  it('appends the trimmed free message as the final block', () => {
    expect(renderPlanFeedback([comment()], '  Also add tests.  ')).toBe(
      '> Step 2: rewrite the config\n\nExtend it instead of rewriting.\n\nAlso add tests.'
    )
  })
  it('renders a message with no comments', () => {
    expect(renderPlanFeedback([], 'Just do it differently.')).toBe('Just do it differently.')
  })
  it('returns an empty string for no comments and no message', () => {
    expect(renderPlanFeedback([])).toBe('')
    expect(renderPlanFeedback([], '   ')).toBe('')
  })
})
