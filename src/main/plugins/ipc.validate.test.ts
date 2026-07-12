import { describe, it, expect } from 'vitest'
import { validateScope, validateName } from './validate'

describe('plugin IPC validators', () => {
  it('accepts good scope/name and rejects junk', () => {
    expect(validateScope('global')).toBe('global')
    expect(() => validateScope('nope')).toThrow()
    expect(validateName('my-plugin')).toBe('my-plugin')
    expect(() => validateName('../x')).toThrow()
    expect(() => validateName('')).toThrow()
  })
})
