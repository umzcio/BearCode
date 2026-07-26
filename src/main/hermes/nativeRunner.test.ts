import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AttachmentRef,
  ConversationMeta,
  Event,
  HermesAttachment
} from '../../shared/types'
import { HermesNativeClientError } from './nativeClient'
import type { HermesNativeTurnOptions } from './nativeClient'
import { HERMES_MAX_TEXT_LENGTH } from './protocol'
import type { HermesServerEvent } from './protocol'
import type { RunSink } from '../sink'

interface FakeTurn {
  options: HermesNativeTurnOptions
  run: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  resolveApproval: ReturnType<typeof vi.fn>
  resolveClarification: ReturnType<typeof vi.fn>
  complete(result: 'completed' | 'cancelled'): void
  fail(error: Error): void
}

const native = vi.hoisted(() => ({
  turns: [] as FakeTurn[],
  constructorErrors: [] as Error[]
}))

vi.mock('./nativeClient', () => ({
  HermesNativeTurn: class {
    private resolve!: (result: 'completed' | 'cancelled') => void
    private reject!: (error: Error) => void
    readonly run = vi.fn(
      () =>
        new Promise<'completed' | 'cancelled'>((resolve, reject) => {
          this.resolve = resolve
          this.reject = reject
        })
    )
    readonly cancel = vi.fn()
    readonly resolveApproval = vi.fn()
    readonly resolveClarification = vi.fn()
    readonly complete = (result: 'completed' | 'cancelled'): void => this.resolve(result)
    readonly fail = (error: Error): void => this.reject(error)

    constructor(readonly options: HermesNativeTurnOptions) {
      const error = native.constructorErrors.shift()
      if (error) throw error
      native.turns.push(this as unknown as FakeTurn)
    }
  },
  HermesNativeClientError: class extends Error {
    constructor(
      message: string,
      public readonly kind: string,
      public readonly code: string,
      public readonly retryable = false
    ) {
      super(message)
      this.name = 'HermesNativeClientError'
    }
  }
}))

vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  appendOrReplaceEvent: vi.fn(),
  getConversationMeta: vi.fn(),
  setHermesSessionId: vi.fn()
}))
vi.mock('../settings', () => ({ getSettings: vi.fn() }))
vi.mock('../keys', () => ({
  getHermesPlatformKey: vi.fn(),
  getOrCreateHermesInstallationId: vi.fn()
}))

import {
  cancelHermesNative,
  resolveHermesApproval,
  resolveHermesClarification,
  runHermesNative
} from './nativeRunner'
import {
  appendEvent,
  appendOrReplaceEvent,
  getConversationMeta,
  setHermesSessionId
} from '../db'
import { getSettings } from '../settings'
import { getHermesPlatformKey, getOrCreateHermesInstallationId } from '../keys'

const ids = {
  conversation: '11111111-1111-4111-8111-111111111111',
  message: '22222222-2222-4222-8222-222222222222',
  tool: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4444-8444-444444444444',
  attachment: '55555555-5555-4555-8555-555555555555',
  clarification: '88888888-8888-4888-8888-888888888888',
  conversationTwo: '99999999-9999-4999-8999-999999999999',
  requestTwo: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clarificationTwo: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}

const attachmentRef: AttachmentRef = {
  id: 'input-one',
  name: 'input.txt',
  mime: 'text/plain',
  kind: 'text'
}

const makeSink = (): RunSink => ({
  emit: vi.fn(),
  setState: vi.fn(),
  metaChanged: vi.fn()
})

const emitted = (sink: RunSink): Event[] =>
  vi.mocked(sink.emit).mock.calls.map(([, event]) => event)

const serverEvent = (
  type: HermesServerEvent['type'],
  payload: unknown,
  sequence = 1
): HermesServerEvent =>
  ({
    type,
    version: 1,
    turnId: '66666666-6666-4666-8666-666666666666',
    sequence,
    payload
  }) as HermesServerEvent

function beginFor(
  conversationId: string,
  sink = makeSink(),
  attachments: AttachmentRef[] = []
): { promise: ReturnType<typeof runHermesNative>; sink: RunSink; turn: FakeTurn } {
  const promise = runHermesNative(
    conversationId,
    'do the work',
    attachments,
    sink,
    new AbortController().signal
  )
  const turn = native.turns.at(-1)
  if (!turn) throw new Error('native turn was not constructed')
  return { promise, sink, turn }
}

function begin(
  sink = makeSink(),
  attachments: AttachmentRef[] = []
): { promise: ReturnType<typeof runHermesNative>; sink: RunSink; turn: FakeTurn } {
  return beginFor(ids.conversation, sink, attachments)
}

beforeEach(() => {
  vi.clearAllMocks()
  native.turns.length = 0
  native.constructorErrors.length = 0
  vi.mocked(getSettings).mockReturnValue({
    hermesNativeUrl: 'https://hermes.example.test'
  } as never)
  vi.mocked(getHermesPlatformKey).mockReturnValue('platform-secret')
  vi.mocked(getOrCreateHermesInstallationId).mockReturnValue(
    '77777777-7777-4777-8777-777777777777'
  )
  vi.mocked(getConversationMeta).mockReturnValue({
    id: ids.conversation,
    hermesSessionId: 'session-new'
  } as ConversationMeta)
})

describe('runHermesNative assistant output', () => {
  it('re-emits cumulative deltas under one stable assistant event id and persists completion once', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(serverEvent('assistant.started', { messageId: ids.message }))
    turn.options.onEvent(
      serverEvent('assistant.delta', { messageId: ids.message, text: 'Hel' }, 2)
    )
    turn.options.onEvent(
      serverEvent('assistant.delta', { messageId: ids.message, text: 'lo' }, 3)
    )
    turn.options.onEvent(serverEvent('assistant.completed', { messageId: ids.message }, 4))
    turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-new' }, 5))
    turn.complete('completed')
    await promise

    expect(emitted(sink).filter((event) => event.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', id: ids.message, text: 'Hel' },
      { type: 'assistant_text', id: ids.message, text: 'Hello' }
    ])
    expect(appendEvent).toHaveBeenCalledWith(ids.conversation, {
      type: 'assistant_text',
      id: ids.message,
      text: 'Hello'
    })
    expect(
      vi.mocked(appendEvent).mock.calls.filter(([, event]) => event.type === 'assistant_text')
    ).toHaveLength(1)
  })

  it('persists partial assistant text before the recoverable error when a turn fails', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(serverEvent('assistant.started', { messageId: ids.message }))
    turn.options.onEvent(
      serverEvent('assistant.delta', { messageId: ids.message, text: 'Partial' }, 2)
    )
    turn.fail(new Error('gateway fell over'))
    await expect(promise).resolves.toEqual({ paused: false, failed: true })

    const writes = vi.mocked(appendEvent).mock.calls.map(([, event]) => event)
    expect(writes[0]).toEqual({
      type: 'assistant_text',
      id: ids.message,
      text: 'Partial'
    })
    expect(writes[1]).toMatchObject({
      type: 'error',
      message: 'gateway fell over',
      recoverable: true
    })
    expect(sink.setState).toHaveBeenCalledWith(ids.conversation, 'error')
    expect(native.turns).toHaveLength(1)
  })

  it('persists a retryable wire error onto the error event', async () => {
    const { promise, turn } = begin()
    turn.fail(new HermesNativeClientError('agent overloaded', 'hermes', 'agent.overloaded', true))
    await expect(promise).resolves.toEqual({ paused: false, failed: true })

    const writes = vi.mocked(appendEvent).mock.calls.map(([, event]) => event)
    const errorEvent = writes.find((event) => event.type === 'error')
    expect(errorEvent).toMatchObject({
      type: 'error',
      message: 'agent overloaded',
      recoverable: true,
      retryable: true
    })
  })

  it('omits retryable when the underlying error is not a HermesNativeClientError', async () => {
    const { promise, turn } = begin()
    turn.fail(new Error('socket exploded'))
    await expect(promise).resolves.toEqual({ paused: false, failed: true })

    const writes = vi.mocked(appendEvent).mock.calls.map(([, event]) => event)
    const errorEvent = writes.find((event) => event.type === 'error') as
      | { retryable?: boolean }
      | undefined
    expect(errorEvent?.retryable).toBeUndefined()
    expect(errorEvent).not.toHaveProperty('retryable')
  })

  it('truncates accumulated assistant text at HERMES_MAX_TEXT_LENGTH instead of growing unbounded', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(serverEvent('assistant.started', { messageId: ids.message }))

    // A single delta that overshoots the cap should be truncated, not rejected.
    turn.options.onEvent(
      serverEvent(
        'assistant.delta',
        { messageId: ids.message, text: 'x'.repeat(HERMES_MAX_TEXT_LENGTH + 100) },
        2
      )
    )
    const emitsAfterFirstDelta = emitted(sink).filter(
      (event) => event.type === 'assistant_text'
    ).length

    // Further deltas for the same message, once truncated, must be no-ops:
    // no further growth, no redundant re-emit/re-slice.
    turn.options.onEvent(
      serverEvent('assistant.delta', { messageId: ids.message, text: 'more text' }, 3)
    )
    turn.options.onEvent(
      serverEvent('assistant.delta', { messageId: ids.message, text: 'even more' }, 4)
    )
    turn.options.onEvent(serverEvent('assistant.completed', { messageId: ids.message }, 5))
    turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-new' }, 6))
    turn.complete('completed')
    await promise

    const deltaEmits = emitted(sink).filter(
      (event) => event.type === 'assistant_text'
    ) as Array<{ text: string }>
    expect(deltaEmits.length).toBe(emitsAfterFirstDelta)
    expect(deltaEmits.at(-1)?.text.length).toBe(HERMES_MAX_TEXT_LENGTH)

    const persisted = vi
      .mocked(appendEvent)
      .mock.calls.map(([, event]) => event)
      .find((event) => event.type === 'assistant_text')
    expect(persisted).toMatchObject({ type: 'assistant_text', id: ids.message })
    expect((persisted as { text: string }).text.length).toBe(HERMES_MAX_TEXT_LENGTH)
  })
})

describe('runHermesNative tools and interactions', () => {
  it('replaces one stable tool card through start and progress, then persists call and result', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(1_175)
    const { promise, sink, turn } = begin()
    turn.options.onEvent(
      serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'Starting' })
    )
    turn.options.onEvent(
      serverEvent('tool.progress', { toolCallId: ids.tool, label: 'Running tests' }, 2)
    )
    turn.options.onEvent(
      serverEvent('tool.completed', { toolCallId: ids.tool, status: 'completed' }, 3)
    )
    turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-new' }, 4))
    turn.complete('completed')
    await promise
    now.mockRestore()

    const cards = emitted(sink).filter((event) => event.type === 'hermes_tool_call')
    expect(cards).toEqual([
      {
        type: 'hermes_tool_call',
        id: ids.tool,
        name: 'terminal',
        label: 'Starting',
        status: 'running'
      },
      {
        type: 'hermes_tool_call',
        id: ids.tool,
        name: 'terminal',
        label: 'Running tests',
        status: 'running'
      },
      {
        type: 'hermes_tool_call',
        id: ids.tool,
        name: 'terminal',
        label: 'Running tests',
        status: 'completed'
      }
    ])
    expect(
      vi.mocked(appendOrReplaceEvent).mock.calls
        .map(([, event]) => event)
        .filter((event) => event.type === 'hermes_tool_call')
    ).toEqual(cards)
    expect(appendEvent).toHaveBeenCalledWith(
      ids.conversation,
      expect.objectContaining({
        type: 'hermes_tool_result',
        callId: ids.tool,
        status: 'completed',
        durationMs: 75
      })
    )
  })

  it('emits approval pending only live, then routes and persists the resolved tool card', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(
      serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'Run command' })
    )
    vi.mocked(appendOrReplaceEvent).mockClear()
    turn.options.onEvent(
      serverEvent('approval.requested', {
        requestId: ids.request,
        toolCallId: ids.tool,
        command: 'npm test',
        description: 'Run the tests',
        allowSession: true,
        allowPermanent: false,
        smartDenied: false
      }, 2)
    )

    expect(emitted(sink).at(-1)).toEqual({
      type: 'hermes_tool_call',
      id: ids.tool,
      name: 'terminal',
      label: 'Run command',
      status: 'awaiting-approval',
      requestId: ids.request,
      command: 'npm test',
      description: 'Run the tests',
      allowSession: true,
      allowPermanent: false,
      smartDenied: false
    })
    expect(appendOrReplaceEvent).not.toHaveBeenCalled()

    expect(resolveHermesApproval(ids.conversation, ids.request, 'session')).toBe(true)
    expect(turn.resolveApproval).toHaveBeenCalledWith(ids.request, 'session')
    expect(appendOrReplaceEvent).toHaveBeenCalledWith(
      ids.conversation,
      expect.objectContaining({
        type: 'hermes_tool_call',
        id: ids.tool,
        status: 'running',
        approvalDecision: 'session'
      })
    )

    turn.options.onEvent(
      serverEvent('tool.progress', { toolCallId: ids.tool, label: 'Approved command running' }, 3)
    )
    turn.options.onEvent(
      serverEvent('tool.completed', { toolCallId: ids.tool, status: 'completed' }, 4)
    )
    expect(appendOrReplaceEvent).toHaveBeenLastCalledWith(ids.conversation, {
      type: 'hermes_tool_call',
      id: ids.tool,
      name: 'terminal',
      label: 'Approved command running',
      status: 'completed',
      requestId: ids.request,
      command: 'npm test',
      description: 'Run the tests',
      allowSession: true,
      allowPermanent: false,
      smartDenied: false,
      approvalDecision: 'session'
    })

    turn.options.onEvent(serverEvent('turn.cancelled', {}, 5))
    turn.complete('cancelled')
    await promise
  })

  it('keeps clarification pending live, then routes and persists the answered card', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(
      serverEvent('clarification.requested', {
        requestId: ids.request,
        question: 'Which target?',
        choices: ['web', 'desktop']
      })
    )

    expect(emitted(sink).at(-1)).toEqual({
      type: 'hermes_clarification',
      id: ids.request,
      requestId: ids.request,
      question: 'Which target?',
      choices: ['web', 'desktop'],
      state: 'pending'
    })
    expect(appendOrReplaceEvent).not.toHaveBeenCalled()

    expect(resolveHermesClarification(ids.conversation, ids.request, 'desktop')).toBe(true)
    expect(turn.resolveClarification).toHaveBeenCalledWith(ids.request, 'desktop')
    expect(appendOrReplaceEvent).toHaveBeenCalledWith(ids.conversation, {
      type: 'hermes_clarification',
      id: ids.request,
      requestId: ids.request,
      question: 'Which target?',
      choices: ['web', 'desktop'],
      state: 'answered',
      response: 'desktop'
    })

    turn.options.onEvent(serverEvent('turn.cancelled', {}, 2))
    turn.complete('cancelled')
    await promise
  })

  it('persists duration zero when tool completion has no matching start', async () => {
    const { promise, turn } = begin()
    turn.options.onEvent(
      serverEvent('tool.completed', { toolCallId: ids.tool, status: 'failed' })
    )
    turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-new' }, 2))
    turn.complete('completed')
    await promise

    expect(appendEvent).toHaveBeenCalledWith(
      ids.conversation,
      expect.objectContaining({
        type: 'hermes_tool_result',
        callId: ids.tool,
        status: 'failed',
        durationMs: 0
      })
    )
  })
})

describe('runHermesNative terminal behavior', () => {
  it('persists downloaded attachments without exposing a filesystem path', async () => {
    const downloaded: HermesAttachment = {
      id: ids.attachment,
      name: 'report.pdf',
      mime: 'application/pdf',
      kind: 'document',
      sizeBytes: 2048,
      sha256: 'abc123'
    }
    const { promise, turn } = begin(undefined, [attachmentRef])
    turn.options.onAttachment(downloaded)
    turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-new' }))
    turn.complete('completed')
    await promise

    expect(appendEvent).toHaveBeenCalledWith(ids.conversation, {
      type: 'assistant_attachment',
      id: ids.attachment,
      attachment: downloaded
    })
    expect(JSON.stringify(vi.mocked(appendEvent).mock.calls)).not.toContain('/tmp/')
  })

  it('persists the returned session, emits refreshed metadata and turn_meta, then closes done', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(10_250)
    const { promise, sink, turn } = begin()
    turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-new' }))
    turn.complete('completed')
    await expect(promise).resolves.toEqual({ paused: false })
    now.mockRestore()

    expect(setHermesSessionId).toHaveBeenCalledWith(ids.conversation, 'session-new')
    expect(sink.metaChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.conversation, hermesSessionId: 'session-new' })
    )
    expect(appendEvent).toHaveBeenCalledWith(ids.conversation, {
      type: 'turn_meta',
      id: expect.any(String),
      provider: 'hermes',
      model: 'agent',
      startedAt: 10_000,
      endedAt: 10_250
    })
    expect(sink.setState).toHaveBeenLastCalledWith(ids.conversation, 'done')

    const sessionOrder = vi.mocked(setHermesSessionId).mock.invocationCallOrder[0]
    const metaOrder = vi.mocked(sink.metaChanged).mock.invocationCallOrder[0]
    const turnMetaAppendOrder = vi.mocked(appendEvent).mock.invocationCallOrder.find(
      (_, index) => vi.mocked(appendEvent).mock.calls[index][1].type === 'turn_meta'
    )
    const turnMetaEmitOrder = vi.mocked(sink.emit).mock.invocationCallOrder.find(
      (_, index) => vi.mocked(sink.emit).mock.calls[index][1].type === 'turn_meta'
    )
    const doneOrder = vi.mocked(sink.setState).mock.invocationCallOrder.at(-1)
    expect(sessionOrder).toBeLessThan(metaOrder)
    expect(metaOrder).toBeLessThan(turnMetaAppendOrder!)
    expect(metaOrder).toBeLessThan(turnMetaEmitOrder!)
    expect(turnMetaAppendOrder!).toBeLessThan(doneOrder!)
    expect(turnMetaEmitOrder!).toBeLessThan(doneOrder!)
  })

  it('persists partial assistant text before failing a completion that omitted the session id', async () => {
    const { promise, turn } = begin()
    turn.options.onEvent(serverEvent('assistant.started', { messageId: ids.message }))
    turn.options.onEvent(
      serverEvent('assistant.delta', { messageId: ids.message, text: 'Still useful' }, 2)
    )
    turn.complete('completed')

    await expect(promise).resolves.toEqual({ paused: false, failed: true })
    const writes = vi.mocked(appendEvent).mock.calls.map(([, event]) => event)
    expect(writes[0]).toEqual({
      type: 'assistant_text',
      id: ids.message,
      text: 'Still useful'
    })
    expect(writes[1]).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/session id/i),
      recoverable: true
    })
  })

  it('maps cancellation to cancelled and never creates an automatic replay turn', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(
      serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'Run command' })
    )
    turn.options.onEvent(
      serverEvent('approval.requested', {
        requestId: ids.request,
        toolCallId: ids.tool,
        command: 'npm test',
        description: 'Run the tests',
        allowSession: true,
        allowPermanent: false,
        smartDenied: false
      }, 2)
    )
    expect(cancelHermesNative(ids.conversation)).toBe(true)
    expect(turn.cancel).toHaveBeenCalledOnce()
    expect(resolveHermesApproval(ids.conversation, ids.request, 'once')).toBe(false)
    expect(turn.resolveApproval).not.toHaveBeenCalled()
    turn.options.onEvent(serverEvent('turn.cancelled', {}))
    turn.complete('cancelled')
    await expect(promise).resolves.toEqual({ paused: false, failed: true })

    expect(sink.setState).toHaveBeenCalledWith(ids.conversation, 'cancelled')
    expect(native.turns).toHaveLength(1)
    expect(cancelHermesNative(ids.conversation)).toBe(false)
  })

  it('enforces one active native turn per conversation', async () => {
    const first = begin()
    const secondSink = makeSink()
    await expect(
      runHermesNative(
        ids.conversation,
        'second',
        [],
        secondSink,
        new AbortController().signal
      )
    ).resolves.toEqual({ paused: false, failed: true })

    expect(native.turns).toHaveLength(1)
    expect(emitted(secondSink)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringMatching(/already.*active/i),
        recoverable: true
      })
    )

    first.turn.options.onEvent(serverEvent('turn.cancelled', {}))
    first.turn.complete('cancelled')
    await first.promise
  })

  it('allows simultaneous active turns for two different conversations', async () => {
    const first = beginFor(ids.conversation)
    const second = beginFor(ids.conversationTwo)

    expect(native.turns).toHaveLength(2)
    expect(first.turn.options.conversationId).toBe(ids.conversation)
    expect(second.turn.options.conversationId).toBe(ids.conversationTwo)

    first.turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-one' }))
    second.turn.options.onEvent(serverEvent('turn.completed', { sessionId: 'session-two' }))
    first.turn.complete('completed')
    second.turn.complete('completed')
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual([
      { paused: false },
      { paused: false }
    ])
  })

  it('does not resolve approval or clarification ownership through the wrong conversation', async () => {
    const first = beginFor(ids.conversation)
    const second = beginFor(ids.conversationTwo)
    first.turn.options.onEvent(
      serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'First' })
    )
    first.turn.options.onEvent(
      serverEvent('approval.requested', {
        requestId: ids.request,
        toolCallId: ids.tool,
        command: 'first',
        description: 'First approval',
        allowSession: true,
        allowPermanent: false,
        smartDenied: false
      }, 2)
    )
    first.turn.options.onEvent(
      serverEvent('clarification.requested', {
        requestId: ids.clarification,
        question: 'First question?',
        choices: []
      }, 3)
    )
    second.turn.options.onEvent(
      serverEvent('tool.started', {
        toolCallId: ids.attachment,
        name: 'terminal',
        label: 'Second'
      })
    )
    second.turn.options.onEvent(
      serverEvent('approval.requested', {
        requestId: ids.requestTwo,
        toolCallId: ids.attachment,
        command: 'second',
        description: 'Second approval',
        allowSession: false,
        allowPermanent: false,
        smartDenied: false
      }, 2)
    )
    second.turn.options.onEvent(
      serverEvent('clarification.requested', {
        requestId: ids.clarificationTwo,
        question: 'Second question?',
        choices: []
      }, 3)
    )

    expect(resolveHermesApproval(ids.conversation, ids.requestTwo, 'once')).toBe(false)
    expect(resolveHermesApproval(ids.conversationTwo, ids.request, 'once')).toBe(false)
    expect(
      resolveHermesClarification(ids.conversation, ids.clarificationTwo, 'wrong')
    ).toBe(false)
    expect(
      resolveHermesClarification(ids.conversationTwo, ids.clarification, 'wrong')
    ).toBe(false)
    expect(first.turn.resolveApproval).not.toHaveBeenCalled()
    expect(second.turn.resolveApproval).not.toHaveBeenCalled()
    expect(first.turn.resolveClarification).not.toHaveBeenCalled()
    expect(second.turn.resolveClarification).not.toHaveBeenCalled()

    first.turn.options.onEvent(serverEvent('turn.cancelled', {}, 4))
    second.turn.options.onEvent(serverEvent('turn.cancelled', {}, 4))
    first.turn.complete('cancelled')
    second.turn.complete('cancelled')
    await Promise.all([first.promise, second.promise])
  })

  it.each([
    ['turn.completed', { sessionId: 'session-new' }, 'completed'],
    ['turn.failed', { error: { code: 'agent.failed', message: 'failed', retryable: false } }, 'failed'],
    ['turn.cancelled', {}, 'cancelled']
  ] as const)(
    'invalidates interaction ownership immediately on %s before run settlement',
    async (type, payload, settlement) => {
      const { promise, turn } = begin()
      turn.options.onEvent(
        serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'Run' })
      )
      turn.options.onEvent(
        serverEvent('approval.requested', {
          requestId: ids.request,
          toolCallId: ids.tool,
          command: 'npm test',
          description: 'Run tests',
          allowSession: true,
          allowPermanent: false,
          smartDenied: false
        }, 2)
      )
      turn.options.onEvent(
        serverEvent('clarification.requested', {
          requestId: ids.clarification,
          question: 'Which?',
          choices: ['one']
        }, 3)
      )

      turn.options.onEvent(serverEvent(type, payload, 4))

      expect(resolveHermesApproval(ids.conversation, ids.request, 'once')).toBe(false)
      expect(resolveHermesClarification(ids.conversation, ids.clarification, 'one')).toBe(false)
      expect(turn.resolveApproval).not.toHaveBeenCalled()
      expect(turn.resolveClarification).not.toHaveBeenCalled()

      if (settlement === 'completed') turn.complete('completed')
      else if (settlement === 'cancelled') turn.complete('cancelled')
      else turn.fail(new Error('failed'))
      await promise
    }
  )

  it('flips a still-pending approval and clarification to a terminal status when the turn rejects without a wire event', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(
      serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'Run' })
    )
    turn.options.onEvent(
      serverEvent('approval.requested', {
        requestId: ids.request,
        toolCallId: ids.tool,
        command: 'npm test',
        description: 'Run tests',
        allowSession: true,
        allowPermanent: false,
        smartDenied: false
      }, 2)
    )
    turn.options.onEvent(
      serverEvent('clarification.requested', {
        requestId: ids.clarification,
        question: 'Which?',
        choices: ['one']
      }, 3)
    )

    // Simulate a heartbeat timeout / dropped socket: HermesNativeTurn.run()
    // rejects directly, with NO turn.failed/turn.cancelled wire event ever
    // reaching onEvent -- this is the exact gap this plan closes.
    turn.fail(new Error('heartbeat timed out'))
    await expect(promise).resolves.toEqual({ paused: false, failed: true })

    expect(resolveHermesApproval(ids.conversation, ids.request, 'once')).toBe(false)
    expect(resolveHermesClarification(ids.conversation, ids.clarification, 'one')).toBe(false)
    expect(turn.resolveApproval).not.toHaveBeenCalled()
    expect(turn.resolveClarification).not.toHaveBeenCalled()

    const toolCallEvents = emitted(sink).filter(
      (event) => event.type === 'hermes_tool_call'
    ) as Array<{ status: string }>
    expect(toolCallEvents.at(-1)?.status).toBe('failed')

    const clarificationEvents = emitted(sink).filter(
      (event) => event.type === 'hermes_clarification'
    ) as Array<{ state: string }>
    expect(clarificationEvents.at(-1)?.state).toBe('expired')

    const persisted = vi.mocked(appendOrReplaceEvent).mock.calls.map(([, event]) => event)
    expect(
      persisted.some((event) => event.type === 'hermes_tool_call' && event.status === 'failed')
    ).toBe(true)
    expect(
      persisted.some(
        (event) => event.type === 'hermes_clarification' && event.state === 'expired'
      )
    ).toBe(true)
  })

  it('flips a still-pending approval to a terminal status when cancelHermesNative runs', async () => {
    const { promise, sink, turn } = begin()
    turn.options.onEvent(
      serverEvent('tool.started', { toolCallId: ids.tool, name: 'terminal', label: 'Run command' })
    )
    turn.options.onEvent(
      serverEvent('approval.requested', {
        requestId: ids.request,
        toolCallId: ids.tool,
        command: 'npm test',
        description: 'Run the tests',
        allowSession: true,
        allowPermanent: false,
        smartDenied: false
      }, 2)
    )

    expect(cancelHermesNative(ids.conversation)).toBe(true)

    const toolCallEvents = emitted(sink).filter(
      (event) => event.type === 'hermes_tool_call'
    ) as Array<{ status: string }>
    expect(toolCallEvents.at(-1)?.status).toBe('failed')

    turn.options.onEvent(serverEvent('turn.cancelled', {}, 3))
    turn.complete('cancelled')
    await expect(promise).resolves.toEqual({ paused: false, failed: true })
  })

  it('allows a later turn after constructor failure and after run rejection', async () => {
    native.constructorErrors.push(new Error('constructor failed'))
    await expect(
      runHermesNative(
        ids.conversation,
        'first',
        [],
        makeSink(),
        new AbortController().signal
      )
    ).rejects.toThrow('constructor failed')

    const afterConstructor = begin()
    afterConstructor.turn.fail(new Error('run rejected'))
    await expect(afterConstructor.promise).resolves.toEqual({ paused: false, failed: true })

    const afterRejection = begin()
    afterRejection.turn.options.onEvent(
      serverEvent('turn.completed', { sessionId: 'session-after-rejection' })
    )
    afterRejection.turn.complete('completed')
    await expect(afterRejection.promise).resolves.toEqual({ paused: false })
  })
})
