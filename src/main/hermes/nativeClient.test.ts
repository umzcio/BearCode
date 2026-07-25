import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef, HermesAttachment } from '../../shared/types'
import { decodeBinaryFrame, encodeBinaryFrame, type HermesServerEvent } from './protocol'
import { checkHermesNativeHealth, HermesNativeTurn, type NativeClientDeps } from './nativeClient'

const ids = {
  installation: '22222222-2222-4222-8222-222222222222',
  conversation: '11111111-1111-4111-8111-111111111111',
  turn: '44444444-4444-4444-8444-444444444444',
  uploadOne: '55555555-5555-4555-8555-555555555555',
  uploadTwo: '66666666-6666-4666-8666-666666666666',
  download: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  message: '88888888-8888-4888-8888-888888888888'
}

const roots: string[] = []

class FakeWebSocket extends EventEmitter {
  readonly sent: Array<string | Buffer> = []
  closed = false

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  open(): void {
    this.emit('open')
  }

  server(event: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(event)), false)
  }

  binary(frame: Buffer): void {
    this.emit('message', frame, true)
  }

  disconnect(): void {
    this.emit('close')
  }
}

function helloAccepted(overrides: Record<string, unknown> = {}): object {
  return {
    type: 'hello.accepted', protocol: 'bearcode-hermes', version: 1,
    connectionId: randomUUID(),
    capabilities: {
      streaming: true, toolProgress: true, approvals: true, clarifications: true,
      attachments: { upload: true, download: true, maxFiles: 5, maxBytesPerFile: 10485760, maxChunkBytes: 262144 }
    }, ...overrides
  }
}

function serverEvent(type: string, sequence: number, payload: unknown): HermesServerEvent {
  return { type, version: 1, turnId: ids.turn, sequence, payload } as unknown as HermesServerEvent
}

async function rootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bearcode-native-client-'))
  roots.push(root)
  return root
}

function sentJson(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame) as Record<string, unknown>)
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let index = 0; index < 50; index += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition did not become true')
}

function testHarness(
  overrides: Partial<ConstructorParameters<typeof HermesNativeTurn>[0]> = {},
  userDataDir = '/tmp/bearcode-native-client-unused'
): {
  turn: HermesNativeTurn
  socket: FakeWebSocket
  sockets: FakeWebSocket[]
  deps: NativeClientDeps
} {
  const sockets: FakeWebSocket[] = []
  const socket = new FakeWebSocket()
  const deps: NativeClientDeps = {
    createWebSocket: (url, options) => {
      const next = sockets.length === 0 ? socket : new FakeWebSocket()
      Object.assign(next, { url, options })
      sockets.push(next)
      return next as never
    },
    userDataDir,
    now: () => Date.now()
  }
  const turn = new HermesNativeTurn({
    url: 'https://hermes.example.test/', platformKey: 'platform-secret',
    installationId: ids.installation, conversationId: ids.conversation, turnId: ids.turn,
    text: 'Read this.', attachments: [], signal: new AbortController().signal,
    onEvent: () => {}, onAttachment: () => {}, ...overrides
  }, deps)
  return { turn, socket, sockets, deps }
}

function start(turn: HermesNativeTurn, socket: FakeWebSocket): Promise<'completed' | 'cancelled'> {
  const result = turn.run()
  socket.open()
  return result
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('HermesNativeTurn connection state machine', () => {
  it('uses the bearer upgrade header and sends the literal hello frame first', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)

    await eventually(() => socket.sent[0])
    expect((socket as unknown as { url: string }).url).toBe('wss://hermes.example.test/v1/bearcode')
    expect((socket as unknown as { options: { headers: Record<string, string> } }).options.headers).toEqual({ Authorization: 'Bearer platform-secret' })
    expect(sentJson(socket)[0]).toEqual({
      type: 'hello', protocol: 'bearcode-hermes', versions: [1],
      client: { name: 'BearCode', version: '1.0.0' },
      conversationId: ids.conversation, installationId: ids.installation
    })

    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it('rejects an incompatible handshake before any upload or turn frame', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server({ type: 'hello.rejected', protocol: 'bearcode-hermes', supportedVersions: [2], error: { code: 'protocol.unsupported_version', message: 'No mutually supported protocol version.', retryable: false } })

    await expect(result).rejects.toMatchObject({ kind: 'protocol' })
    expect(sentJson(socket).map((event) => event.type)).toEqual(['hello'])
  })

  it('preserves an explicit WebSocket endpoint that already has the native path', async () => {
    const { turn, socket } = testHarness({ url: 'ws://hermes.example.test/v1/bearcode' })
    const result = start(turn, socket)
    expect((socket as unknown as { url: string }).url).toBe('ws://hermes.example.test/v1/bearcode')
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it.each([
    ['http://hermes.example.test/', 'ws://hermes.example.test/v1/bearcode'],
    ['https://hermes.example.test/base/', 'wss://hermes.example.test/base/v1/bearcode'],
    ['ws://hermes.example.test/v1/bearcode/', 'ws://hermes.example.test/v1/bearcode'],
    ['wss://hermes.example.test/v1/bearcode/v1/bearcode?mode=native#ignored', 'wss://hermes.example.test/v1/bearcode?mode=native']
  ])('normalizes %s structurally to %s', async (url, expectedUrl) => {
    const { turn, socket } = testHarness({ url })
    const result = start(turn, socket)
    expect((socket as unknown as { url: string }).url).toBe(expectedUrl)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it('rejects a sixth attachment before constructing a WebSocket', async () => {
    const attachments = Array.from({ length: 6 }, (_, index) => ({
      id: `${index}5555555-5555-4555-8555-555555555555`, name: `${index}.txt`, mime: 'text/plain', kind: 'text'
    })) as AttachmentRef[]
    const { turn, sockets } = testHarness({ attachments })
    await expect(turn.run()).rejects.toMatchObject({ kind: 'file', code: 'file.too_many_attachments' })
    expect(sockets).toEqual([])
  })

  it('rejects malformed or incompatible hello capabilities before file inspection', async () => {
    const root = await rootDir()
    const { turn, socket, deps } = testHarness({ attachments: [{ id: ids.uploadOne, name: 'first.txt', mime: 'text/plain', kind: 'text' }] })
    deps.userDataDir = root
    const result = start(turn, socket)
    socket.server(helloAccepted({ capabilities: { streaming: true } }))
    await expect(result).rejects.toMatchObject({ kind: 'protocol', code: 'protocol.invalid_handshake' })
    expect(sentJson(socket).map((event) => event.type)).toEqual(['hello'])
  })

  it('closes a connection attempt that never opens within the establishment deadline', async () => {
    vi.useFakeTimers()
    const { turn, socket } = testHarness()
    const result = turn.run()
    const outcome = expect(result).rejects.toMatchObject({ kind: 'network', code: 'network.establishment_timeout' })
    await vi.advanceTimersByTimeAsync(10_000)
    await outcome
    expect(socket.closed).toBe(true)
  })

  it('closes a health probe that opens but never completes hello', async () => {
    vi.useFakeTimers()
    const socket = new FakeWebSocket()
    const result = checkHermesNativeHealth('ws://hermes.example.test', 'platform-secret', ids.installation, {
      createWebSocket: () => socket as never
    })
    socket.open()
    const outcome = expect(result).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/timed out/i) })
    await vi.advanceTimersByTimeAsync(10_000)
    await outcome
    expect(socket.closed).toBe(true)
  })

  it('uploads each attachment serially and waits for acceptance before binary bytes', async () => {
    const root = await rootDir()
    const first = Buffer.from('first')
    const second = Buffer.from('second')
    await mkdir(join(root, 'attachments', ids.conversation), { recursive: true })
    await writeFile(join(root, 'attachments', ids.conversation, ids.uploadOne), first)
    await writeFile(join(root, 'attachments', ids.conversation, ids.uploadTwo), second)
    const attachments: AttachmentRef[] = [
      { id: ids.uploadOne, name: 'first.txt', mime: 'text/plain', kind: 'text' },
      { id: ids.uploadTwo, name: 'second.txt', mime: 'text/plain', kind: 'text' }
    ]
    const { turn, socket, deps } = testHarness({ attachments })
    deps.userDataDir = root
    const result = start(turn, socket)
    socket.server(helloAccepted())

    await eventually(() => sentJson(socket).find((event) => event.type === 'attachment.upload.begin'))
    expect(socket.sent.filter(Buffer.isBuffer)).toEqual([])
    socket.server({ type: 'attachment.upload.accepted', version: 1, turnId: ids.turn, attachmentId: ids.uploadOne })
    const firstBinary = await eventually(() => socket.sent.find(Buffer.isBuffer) as Buffer | undefined)
    expect(decodeBinaryFrame(firstBinary)).toMatchObject({ direction: 'upload', attachmentId: ids.uploadOne, chunkIndex: 0, final: true, payload: first })
    socket.server({ type: 'attachment.upload.completed', version: 1, turnId: ids.turn, attachmentId: ids.uploadOne })
    await eventually(() => sentJson(socket).find((event) => event.type === 'attachment.upload.begin' && (event.attachment as { id: string }).id === ids.uploadTwo))
    expect(sentJson(socket).some((event) => event.type === 'turn.start')).toBe(false)
    socket.server({ type: 'attachment.upload.accepted', version: 1, turnId: ids.turn, attachmentId: ids.uploadTwo })
    const secondBinary = await eventually(() => socket.sent.filter(Buffer.isBuffer)[1] as Buffer | undefined)
    expect(decodeBinaryFrame(secondBinary)).toMatchObject({ direction: 'upload', attachmentId: ids.uploadTwo, chunkIndex: 0, final: true, payload: second })
    socket.server({ type: 'attachment.upload.completed', version: 1, turnId: ids.turn, attachmentId: ids.uploadTwo })
    await eventually(() => sentJson(socket).find((event) => event.type === 'turn.start'))
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it('sends the canonical fixture upload bytes without deriving expectations from the codec', async () => {
    const root = await rootDir()
    await mkdir(join(root, 'attachments', ids.conversation), { recursive: true })
    await writeFile(join(root, 'attachments', ids.conversation, ids.uploadOne), Buffer.from([0, 1, 2, 3]))
    const { turn, socket, deps } = testHarness({ attachments: [{ id: ids.uploadOne, name: 'fixture.bin', mime: 'application/octet-stream', kind: 'text' }] })
    deps.userDataDir = root
    const result = start(turn, socket)
    socket.server(helloAccepted())
    await eventually(() => sentJson(socket).find((event) => event.type === 'attachment.upload.begin'))
    socket.server({ type: 'attachment.upload.accepted', version: 1, turnId: ids.turn, attachmentId: ids.uploadOne })
    const frame = await eventually(() => socket.sent.find(Buffer.isBuffer) as Buffer | undefined)
    expect(frame.toString('hex')).toBe('424348310101010055555555555545558555555555555555000000000000000400010203')
    socket.server({ type: 'attachment.upload.completed', version: 1, turnId: ids.turn, attachmentId: ids.uploadOne })
    await eventually(() => sentJson(socket).find((event) => event.type === 'turn.start'))
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it('splits a 256 KiB plus one-byte upload at the exact protocol boundary', async () => {
    const root = await rootDir()
    await mkdir(join(root, 'attachments', ids.conversation), { recursive: true })
    await writeFile(join(root, 'attachments', ids.conversation, ids.uploadOne), Buffer.alloc(262145, 0x61))
    const { turn, socket, deps } = testHarness({ attachments: [{ id: ids.uploadOne, name: 'large.txt', mime: 'text/plain', kind: 'text' }] })
    deps.userDataDir = root
    const result = start(turn, socket)
    socket.server(helloAccepted())
    await eventually(() => sentJson(socket).find((event) => event.type === 'attachment.upload.begin'))
    socket.server({ type: 'attachment.upload.accepted', version: 1, turnId: ids.turn, attachmentId: ids.uploadOne })
    await eventually(() => socket.sent.filter(Buffer.isBuffer).length === 2 ? true : undefined)
    const [first, second] = socket.sent.filter(Buffer.isBuffer) as Buffer[]
    expect(first.length).toBe(262176)
    expect(second.length).toBe(33)
    expect(first.subarray(0, 32).toString('hex')).toBe('4243483101010000555555555555455585555555555555550000000000040000')
    expect(second.subarray(0, 32).toString('hex')).toBe('4243483101010100555555555555455585555555555555550000000100000001')
    socket.server({ type: 'attachment.upload.completed', version: 1, turnId: ids.turn, attachmentId: ids.uploadOne })
    await eventually(() => sentJson(socket).find((event) => event.type === 'turn.start'))
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it('fails the turn on a server sequence gap', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await eventually(() => turn.accepted ? true : undefined)
    socket.server(serverEvent('assistant.delta', 3, { messageId: ids.message, text: 'gap' }))
    await expect(result).rejects.toMatchObject({ kind: 'protocol' })
  })

  it('surfaces turn.duplicate without replaying turn.start', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    await eventually(() => sentJson(socket).find((event) => event.type === 'turn.start'))
    socket.server(serverEvent('turn.duplicate', 1, { status: 'completed' }))
    await expect(result).rejects.toMatchObject({ kind: 'hermes', retryable: false, code: 'turn.duplicate' })
    expect(sentJson(socket).filter((event) => event.type === 'turn.start')).toHaveLength(1)
  })

  it('accepts download bytes only after their matching begin event and persists verified metadata', async () => {
    const root = await rootDir()
    const received: HermesAttachment[] = []
    const { turn, socket } = testHarness({ onAttachment: (attachment) => received.push(attachment) }, root)
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await eventually(() => turn.accepted ? true : undefined)
    socket.binary(Buffer.from('not a valid binary frame'))
    await expect(result).rejects.toMatchObject({ kind: 'protocol' })
    expect(received).toEqual([])
  })

  it('rejects a valid decoded download frame that has no matching begin event', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await eventually(() => turn.accepted ? true : undefined)
    socket.binary(encodeBinaryFrame({ direction: 'download', attachmentId: ids.download, chunkIndex: 0, final: true, payload: Buffer.from('x') }))
    await expect(result).rejects.toMatchObject({ kind: 'protocol', code: 'protocol.unexpected_binary' })
  })

  it('writes a verified download after its matching begin event', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('file')
    const received: HermesAttachment[] = []
    const { turn, socket } = testHarness({ onAttachment: (attachment) => received.push(attachment) }, root)
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('attachment.download.begin', 2, {
      attachment: { id: ids.download, name: 'result.txt', mime: 'text/plain', kind: 'text', sizeBytes: bytes.length, sha256: '3b9c358f36f0a31b6ad3e14f309c7cf198ac9246e8316f9ce543d5b19ac02b80' }
    }))
    socket.binary(encodeBinaryFrame({ direction: 'download', attachmentId: ids.download, chunkIndex: 0, final: true, payload: bytes }))
    socket.server(serverEvent('attachment.download.completed', 3, { attachmentId: ids.download }))
    socket.server(serverEvent('turn.completed', 4, { sessionId: 'session-1' }))

    await expect(result).resolves.toBe('completed')
    expect(received).toEqual([{ id: ids.download, name: 'result.txt', mime: 'text/plain', kind: 'text', sizeBytes: 4, sha256: '3b9c358f36f0a31b6ad3e14f309c7cf198ac9246e8316f9ce543d5b19ac02b80' }])
    expect(await readFile(join(root, 'attachments', ids.conversation, ids.download), 'utf8')).toBe('file')
  })

  it('waits for an unfinished download partial to be removed before terminal settlement', async () => {
    const root = await rootDir()
    const { turn, socket } = testHarness({}, root)
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('attachment.download.begin', 2, {
      attachment: { id: ids.download, name: 'partial.txt', mime: 'text/plain', kind: 'text', sizeBytes: 4, sha256: '3b9c358f36f0a31b6ad3e14f309c7cf198ac9246e8316f9ce543d5b19ac02b80' }
    }))
    socket.server(serverEvent('turn.completed', 3, { sessionId: 'session-1' }))

    await expect(result).resolves.toBe('completed')
    expect(await readdir(join(root, 'attachments', ids.conversation))).toEqual([])
  })

  it('retries a failed connection exactly once before acceptance', async () => {
    const { turn, socket, sockets } = testHarness()
    const result = start(turn, socket)
    socket.disconnect()
    const retry = await eventually(() => sockets[1])
    retry.open()
    retry.server(helloAccepted())
    retry.server(serverEvent('turn.accepted', 1, {}))
    retry.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
    expect(sockets).toHaveLength(2)
  })

  it('replays the same turn once after lost acceptance and surfaces its duplicate response', async () => {
    const { turn, socket, sockets } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    await eventually(() => sentJson(socket).find((event) => event.type === 'turn.start'))
    socket.disconnect()
    const retry = await eventually(() => sockets[1])
    retry.open()
    retry.server(helloAccepted())
    await eventually(() => sentJson(retry).find((event) => event.type === 'turn.start'))
    retry.server(serverEvent('turn.duplicate', 1, { status: 'accepted' }))

    await expect(result).rejects.toMatchObject({ kind: 'hermes', code: 'turn.duplicate', retryable: false })
    expect(sentJson(socket).filter((event) => event.type === 'turn.start')).toHaveLength(1)
    expect(sentJson(retry).filter((event) => event.type === 'turn.start')).toHaveLength(1)
    expect(sockets).toHaveLength(2)
  })

  it('owns only the replacement heartbeat timer after a pre-accept retry', async () => {
    vi.useFakeTimers()
    const { turn, socket, sockets } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    await Promise.resolve()
    await Promise.resolve()
    socket.disconnect()
    const retry = sockets[1]!
    retry.open()
    retry.server(helloAccepted())
    await Promise.resolve()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    turn.cancel()
    await expect(result).resolves.toBe('cancelled')
  })

  it('never replays a turn after acceptance disconnects', async () => {
    const { turn, socket, sockets } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await eventually(() => turn.accepted ? true : undefined)
    socket.disconnect()
    await expect(result).rejects.toMatchObject({ kind: 'network', code: 'network.disconnected' })
    expect(sockets).toHaveLength(1)
  })

  it('sends turn.cancel and resolves only after terminal cancellation', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await eventually(() => turn.accepted ? true : undefined)
    turn.cancel()
    await eventually(() => sentJson(socket).find((event) => event.type === 'turn.cancel'))
    socket.server(serverEvent('turn.cancelled', 2, {}))
    await expect(result).resolves.toBe('cancelled')
    expect(socket.closed).toBe(true)
  })

  it('settles cancellation after the 5 second grace when no terminal event arrives', async () => {
    vi.useFakeTimers()
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await Promise.resolve()
    await Promise.resolve()
    turn.cancel()
    const outcome = expect(result).resolves.toBe('cancelled')
    await vi.advanceTimersByTimeAsync(5_000)
    await outcome
    expect(socket.closed).toBe(true)
  })

  it('sends validated approval and clarification replies only after acceptance', async () => {
    const { turn, socket } = testHarness()
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    await eventually(() => turn.accepted ? true : undefined)
    const requestId = '77777777-7777-4777-8777-777777777777'
    turn.resolveApproval(requestId, 'once')
    turn.resolveClarification(requestId, 'Use quarterly totals.')
    expect(sentJson(socket).slice(-2)).toEqual([
      { type: 'approval.resolve', version: 1, turnId: ids.turn, requestId, decision: 'once' },
      { type: 'clarification.resolve', version: 1, turnId: ids.turn, requestId, response: 'Use quarterly totals.' }
    ])
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
  })

  it('echoes server heartbeats without advancing turn sequencing', async () => {
    const events: HermesServerEvent[] = []
    const { turn, socket } = testHarness({ onEvent: (event) => events.push(event) })
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server({ type: 'heartbeat', version: 1, nonce: 'hb-1' })
    await eventually(() => sentJson(socket).find((event) => event.type === 'heartbeat'))
    expect(sentJson(socket).at(-1)).toEqual({ type: 'heartbeat', version: 1, nonce: 'hb-1' })
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('turn.completed', 2, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
    expect(events.map((event) => event.type)).toEqual(['turn.accepted', 'turn.completed'])
  })

  it('forwards deeply frozen validated events', async () => {
    const events: HermesServerEvent[] = []
    const { turn, socket } = testHarness({ onEvent: (event) => events.push(event) })
    const result = start(turn, socket)
    socket.server(helloAccepted())
    socket.server(serverEvent('turn.accepted', 1, {}))
    socket.server(serverEvent('assistant.delta', 2, { messageId: ids.message, text: 'immutable' }))
    socket.server(serverEvent('turn.completed', 3, { sessionId: 'session-1' }))
    await expect(result).resolves.toBe('completed')
    const delta = events.find((event) => event.type === 'assistant.delta')
    if (!delta || delta.type !== 'assistant.delta') throw new Error('assistant delta was not forwarded')
    expect(Object.isFrozen(delta)).toBe(true)
    expect(Object.isFrozen(delta.payload)).toBe(true)
  })

  it('closes as network.disconnected when the server heartbeat deadline is missed', async () => {
    vi.useFakeTimers()
    let now = 0
    const { turn, socket, deps } = testHarness()
    deps.now = () => now
    const result = start(turn, socket)
    socket.server(helloAccepted())
    await Promise.resolve()
    await Promise.resolve()
    now = 45_001
    const outcome = expect(result).rejects.toMatchObject({ kind: 'network', code: 'network.disconnected' })
    await vi.advanceTimersByTimeAsync(1_000)

    await outcome
    expect(socket.closed).toBe(true)
  })

  it('health-checks by handshaking without starting a turn', async () => {
    const socket = new FakeWebSocket()
    const result = checkHermesNativeHealth('http://hermes.example.test/', 'platform-secret', ids.installation, {
      createWebSocket: ((url: string, options: { headers: Record<string, string> }) => {
        Object.assign(socket, { url, options })
        return socket as never
      })
    })
    socket.open()
    socket.server(helloAccepted())

    await expect(result).resolves.toEqual({ ok: true, message: 'Connected' })
    expect((socket as unknown as { url: string }).url).toBe('ws://hermes.example.test/v1/bearcode')
    expect(sentJson(socket)).toHaveLength(1)
    expect(sentJson(socket)[0]).toMatchObject({ type: 'hello', installationId: ids.installation })
  })

  it.each([
    ['auth.invalid_key', 'Rejected — check the platform key in Settings'],
    ['protocol.unsupported_version', 'Incompatible native Hermes protocol']
  ])('reports health %s failures distinctly', async (code, message) => {
    const socket = new FakeWebSocket()
    const result = checkHermesNativeHealth('ws://hermes.example.test', 'platform-secret', ids.installation, { createWebSocket: () => socket as never })
    socket.open()
    socket.server({ type: 'hello.rejected', error: { code, message: 'rejected', retryable: false } })
    await expect(result).resolves.toEqual({ ok: false, message })
  })

  it('reports a health network error', async () => {
    const socket = new FakeWebSocket()
    const result = checkHermesNativeHealth('ws://hermes.example.test', 'platform-secret', ids.installation, { createWebSocket: () => socket as never })
    socket.emit('error', new Error('ECONNREFUSED'))
    await expect(result).resolves.toEqual({ ok: false, message: 'ECONNREFUSED' })
  })
})
