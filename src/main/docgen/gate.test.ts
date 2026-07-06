import { describe, it, expect } from 'vitest'
import { docGenGateMessage } from './gate'

describe('docGenGateMessage', () => {
  it('apply → null (proceed to write)', () => {
    expect(docGenGateMessage('apply', 'accept-edits')).toBeNull()
  })
  it('block in plan mode → read-only message', () => {
    expect(docGenGateMessage('block', 'plan')).toMatch(/read-only/i)
  })
  it('block via deny rule → blocked message', () => {
    expect(docGenGateMessage('block', 'accept-edits')).toMatch(/blocked by a permission rule/i)
  })
  it('prompt (ask) → switch-modes guidance (no interrupt)', () => {
    expect(docGenGateMessage('prompt', 'ask')).toMatch(/accept edits or auto/i)
  })
})
