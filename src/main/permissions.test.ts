import { describe, it, expect } from 'vitest'
import { commandNeedsApproval } from './permissions'

describe('commandNeedsApproval', () => {
  it('does not prompt in auto mode', () => {
    expect(commandNeedsApproval('auto')).toBe(false)
  })
  it('prompts in accept-edits mode', () => {
    expect(commandNeedsApproval('accept-edits')).toBe(true)
  })
  it('prompts in plan mode (defensive; plan blocks tools entirely in Bc)', () => {
    expect(commandNeedsApproval('plan')).toBe(true)
  })
})
