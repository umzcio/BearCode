import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This file exercises the real `defaultDeps` wiring in nativeClient.ts —
// specifically the `createWebSocket` fallback that constructs the actual
// `ws.WebSocket` (nativeClient.ts's other tests all inject a fake
// `createWebSocket` via test deps, which bypasses this path entirely). Mock
// only the `ws` module's default export so `new WebSocket(...)` inside
// nativeClient.ts resolves to a spyable stand-in while everything else in
// nativeClient.ts runs for real.
const wsMock = vi.hoisted(() => ({
  instances: [] as Array<{ url: string; options: Record<string, unknown> }>
}))

// `defaultDeps` also fills in `userDataDir` via Electron's `app.getPath`, even
// though `checkHermesNativeHealth` never reads it — stub it so construction
// doesn't throw outside a real Electron process.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/bearcode-ws-options-test' } }))

vi.mock('ws', () => ({
  default: class MockWebSocket extends EventEmitter {
    readonly url: string
    readonly options: Record<string, unknown>

    constructor(url: string, options: Record<string, unknown>) {
      super()
      this.url = url
      this.options = options
      wsMock.instances.push(this)
    }

    send(): void {}

    close(): void {
      this.emit('close')
    }
  }
}))

import { checkHermesNativeHealth, HERMES_MAX_WS_PAYLOAD_BYTES } from './nativeClient'

afterEach(() => {
  wsMock.instances.length = 0
  vi.restoreAllMocks()
})

describe('defaultDeps real WebSocket wiring', () => {
  it('constructs the real ws.WebSocket with the HERMES_MAX_WS_PAYLOAD_BYTES cap', async () => {
    const result = checkHermesNativeHealth(
      'wss://hermes.example.test',
      'platform-secret',
      '22222222-2222-4222-8222-222222222222'
    )

    expect(wsMock.instances).toHaveLength(1)
    const instance = wsMock.instances[0]! as unknown as EventEmitter & { url: string; options: Record<string, unknown> }
    expect(instance.url).toBe('wss://hermes.example.test/v1/bearcode')
    expect(instance.options).toMatchObject({
      headers: { Authorization: 'Bearer platform-secret' },
      maxPayload: HERMES_MAX_WS_PAYLOAD_BYTES
    })

    instance.emit('error', new Error('terminate probe'))
    await expect(result).resolves.toMatchObject({ ok: false })
  })
})
