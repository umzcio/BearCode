import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  getConversationMeta: vi.fn()
}))
vi.mock('../settings', () => ({ getSettings: vi.fn() }))
vi.mock('../keys', () => ({ getHermesToken: vi.fn(() => undefined) }))
vi.mock('../hermes/gatewayClient', () => ({
  sendHermesMessage: vi.fn(),
  HermesGatewayError: class HermesGatewayError extends Error {
    kind: string
    constructor(message: string, kind: string) {
      super(message)
      this.kind = kind
    }
  }
}))

import { runHermes, isHermesModelRef, HERMES_MODEL_REF } from './hermes'
import { getConversationMeta, appendEvent } from '../db'
import { getSettings } from '../settings'
import { sendHermesMessage, HermesGatewayError } from '../hermes/gatewayClient'
import type { RunSink } from '../sink'
import type { Event } from '../../shared/types'

const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
const emitted = (sink: RunSink): Event[] => vi.mocked(sink.emit).mock.calls.map((c) => c[1])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSettings).mockReturnValue({
    hermesEnabled: true,
    hermesGatewayUrl: 'http://100.1.1.1:8642'
  } as never)
  vi.mocked(getConversationMeta).mockReturnValue({
    id: 'c1',
    hermesSessionId: 'sess-1'
  } as never)
})

describe('isHermesModelRef', () => {
  it('matches only the Hermes sentinel', () => {
    expect(isHermesModelRef(HERMES_MODEL_REF)).toBe(true)
    expect(isHermesModelRef('ursa/auto')).toBe(false)
  })
})

describe('runHermes', () => {
  it('streams deltas as assistant_text and settles done', async () => {
    vi.mocked(sendHermesMessage).mockImplementation(async ({ onDelta }) => {
      onDelta('Hel')
      onDelta('lo')
    })
    const sink = makeSink()
    const result = await runHermes('c1', 'hi', sink, new AbortController().signal)

    const texts = emitted(sink).filter((e) => e.type === 'assistant_text')
    expect(texts.at(-1)).toMatchObject({ text: 'Hello' })
    expect(sink.setState).toHaveBeenCalledWith('c1', 'done')
    expect(appendEvent).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ type: 'assistant_text', text: 'Hello' })
    )
    expect(result).toEqual({ paused: false })
  })

  it('emits a recoverable error and settles error when Hermes is disabled', async () => {
    vi.mocked(getSettings).mockReturnValue({ hermesEnabled: false } as never)
    const sink = makeSink()
    const result = await runHermes('c1', 'hi', sink, new AbortController().signal)

    expect(emitted(sink)).toContainEqual(
      expect.objectContaining({ type: 'error', recoverable: true })
    )
    expect(sink.setState).toHaveBeenCalledWith('c1', 'error')
    expect(result).toEqual({ paused: false, failed: true })
    expect(sendHermesMessage).not.toHaveBeenCalled()
  })

  it('emits a recoverable error when the conversation has no session id', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ id: 'c1', hermesSessionId: null } as never)
    const sink = makeSink()
    const result = await runHermes('c1', 'hi', sink, new AbortController().signal)

    expect(emitted(sink)).toContainEqual(
      expect.objectContaining({ type: 'error', recoverable: true })
    )
    expect(result.failed).toBe(true)
  })

  it('surfaces an auth error with an actionable message', async () => {
    vi.mocked(sendHermesMessage).mockRejectedValue(
      new HermesGatewayError('rejected', 'auth')
    )
    const sink = makeSink()
    await runHermes('c1', 'hi', sink, new AbortController().signal)

    const error = emitted(sink).find((e) => e.type === 'error')
    expect(error?.message).toMatch(/bearer token/i)
    expect(sink.setState).toHaveBeenCalledWith('c1', 'error')
  })

  it('settles cancelled when the signal was aborted', async () => {
    const controller = new AbortController()
    vi.mocked(sendHermesMessage).mockImplementation(async () => {
      controller.abort()
      throw new Error('aborted mid-stream')
    })
    const sink = makeSink()
    const result = await runHermes('c1', 'hi', sink, controller.signal)

    expect(sink.setState).toHaveBeenCalledWith('c1', 'cancelled')
    expect(result).toEqual({ paused: false, failed: true })
  })
})
