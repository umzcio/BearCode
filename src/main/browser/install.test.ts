import { describe, it, expect } from 'vitest'
import { chromiumInstalled } from './install'

describe('chromiumInstalled', () => {
  it('returns a boolean without throwing', () => {
    expect(typeof chromiumInstalled()).toBe('boolean')
  })
})
