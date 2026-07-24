import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
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

function helloAccepted(): object {
  return {
    type: 'hello.accepted', protocol: 'bearcode-hermes', version: 1,
    connectionId: randomUUID(),
    capabilities: {
      streaming: true, toolProgress: true, approvals: true, clarifications: true,
      attachments: { upload: true, download: true, maxFiles: 5, maxBytesPerFile: 10485760, maxChunkBytes: 262144 }
    }
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
})
