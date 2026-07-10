import { describe, it, expect } from 'vitest'
import { startLoopbackCapture, DEFAULT_TIMEOUT_MS } from './loopback'

describe('startLoopbackCapture', () => {
  it('waits long enough for a real-world first-run consent (incl. provider account signup)', () => {
    // Regression: a live Gmail-via-Composio smoke failed with
    // ERR_CONNECTION_REFUSED because the 5-minute default fired mid-consent
    // (first-time provider account creation + multi-screen Google grant),
    // closing the loopback before the redirect arrived. Keep the default at
    // least 10 minutes — roughly the IdP authorization-code lifetime, beyond
    // which a longer wait buys nothing (the code expires first).
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })

  it('captures the callback query params on the redirect_uri', async () => {
    const capture = await startLoopbackCapture()
    expect(capture.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const waitPromise = capture.wait()
    const res = await fetch(`${capture.redirectUri}?code=abc&state=x`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/close this tab/i)

    const params = await waitPromise
    expect(params.get('code')).toBe('abc')
    expect(params.get('state')).toBe('x')
  })

  it('rejects wait() when no request arrives before the timeout', async () => {
    const capture = await startLoopbackCapture()
    await expect(capture.wait(50)).rejects.toThrow(/timeout/i)
    capture.close()
  })

  it('close() frees the port so a new server can bind afterwards', async () => {
    const capture = await startLoopbackCapture()
    const port = new URL(capture.redirectUri).port
    capture.close()

    // Binding a fresh loopback server on the same host should succeed post-close.
    const capture2 = await startLoopbackCapture()
    expect(typeof capture2.redirectUri).toBe('string')
    capture2.close()
    expect(port).toBeTruthy()
  })

  it('auto-closes the server after wait() resolves', async () => {
    const capture = await startLoopbackCapture()
    const waitPromise = capture.wait()
    await fetch(`${capture.redirectUri}?code=abc`)
    await waitPromise
    // A second request after auto-close should fail to connect.
    await expect(fetch(capture.redirectUri)).rejects.toThrow()
  })
})
