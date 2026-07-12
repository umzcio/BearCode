import { describe, it, expect } from 'vitest'
import { validateHookEvent, validateHookName } from './validate'

describe('hook IPC validators', () => {
  it('accepts good event/name and rejects junk', () => {
    expect(validateHookEvent('PreToolUse')).toBe('PreToolUse')
    expect(validateHookEvent('PostToolUse')).toBe('PostToolUse')
    expect(() => validateHookEvent('nope')).toThrow()
    expect(() => validateHookEvent(undefined)).toThrow()

    expect(validateHookName('my-hook')).toBe('my-hook')
    expect(() => validateHookName('../x')).toThrow()
    expect(() => validateHookName('')).toThrow()
    expect(() => validateHookName('Not_Kebab')).toThrow()
  })
})
