import { describe, it, expect } from 'vitest'
import { describeError } from './errors'

describe('describeError', () => {
  it('strips the Electron invoke wrapper down to the main-side message', () => {
    const err = new Error(
      "Error invoking remote method 'bearcode:conversations:set-execution-mode': " +
        'Error: Execution mode is locked after the first turn'
    )
    expect(describeError(err)).toBe('Execution mode is locked after the first turn')
  })
  it('strips the wrapper when the inner throw was not an Error (no "Error:" prefix)', () => {
    expect(describeError(new Error("Error invoking remote method 'bearcode:x': boom"))).toBe('boom')
  })
  it('passes an unwrapped message through unchanged', () => {
    expect(describeError(new Error('plain failure'))).toBe('plain failure')
  })
  it('falls back for non-Error and empty-message throws', () => {
    expect(describeError('nope')).toBe('Something went wrong. Try again.')
    expect(describeError(new Error(''))).toBe('Something went wrong. Try again.')
  })
})
