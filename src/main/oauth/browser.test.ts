import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(() => Promise.resolve()) } }))

import { shell } from 'electron'
import { openSignIn } from './browser'

describe('oauth/browser openSignIn', () => {
  it('delegates to shell.openExternal with the given URL (never an embedded webview)', async () => {
    await openSignIn('https://github.com/login/oauth/authorize?client_id=abc')
    expect(shell.openExternal).toHaveBeenCalledWith(
      'https://github.com/login/oauth/authorize?client_id=abc'
    )
  })
})
