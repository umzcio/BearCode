import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import WebSocket from 'ws'
import type { AttachmentRef, HermesAttachment } from '../../shared/types'
import {
  HERMES_MAX_CHUNK_BYTES,
  HERMES_PROTOCOL,
  HERMES_PROTOCOL_VERSION,
  ProtocolViolation,
  SequenceGuard,
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeClientEvent,
  parseServerEvent,
  type ApprovalDecision,
  type HermesServerEvent
} from './protocol'
import { NativeDownloadWriter, describeNativeUpload } from './nativeFiles'

export interface HermesNativeTurnOptions {
  url: string
  platformKey: string
  installationId: string
  conversationId: string
  turnId: string
  text: string
  attachments: AttachmentRef[]
  signal: AbortSignal
  onEvent: (event: HermesServerEvent) => void
  onAttachment: (attachment: HermesAttachment) => void
}

export interface NativeClientDeps {
  createWebSocket: (
    url: string,
    options: { headers: Record<string, string> }
  ) => import('ws').WebSocket
  userDataDir: string
  now: () => number
}

export type HermesNativeErrorKind =
  | 'auth'
  | 'protocol'
  | 'network'
  | 'file'
  | 'hermes'
  | 'cancelled'

export class HermesNativeClientError extends Error {
  constructor(
    message: string,
    public readonly kind: HermesNativeErrorKind,
    public readonly code: string,
    public readonly retryable = false
  ) {
    super(message)
    this.name = 'HermesNativeClientError'
  }
}

interface Deferred {
  resolve: () => void
  reject: (error: Error) => void
}

const HEARTBEAT_TIMEOUT_MS = 45_000
const CANCEL_GRACE_MS = 5_000

function nativeUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  const websocketUrl = trimmed.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  if (!/^wss?:\/\//i.test(websocketUrl)) {
    throw new HermesNativeClientError('Native Hermes URL must use http(s) or ws(s)', 'protocol', 'protocol.invalid_url')
  }
  return websocketUrl.endsWith('/v1/bearcode') ? websocketUrl : `${websocketUrl}/v1/bearcode`
}

function defaultDeps(): NativeClientDeps {
  return {
    createWebSocket: (url, options) => new WebSocket(url, options),
    userDataDir: process.env.BEARCODE_USER_DATA ?? process.cwd(),
    now: () => Date.now()
  }
}

function asBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  return Buffer.from(raw)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function errorFromWire(
  error: { code: string; message: string; retryable: boolean },
  fallback: HermesNativeErrorKind = 'hermes'
): HermesNativeClientError {
  const kind: HermesNativeErrorKind = error.code.startsWith('auth.')
    ? 'auth'
    : error.code.startsWith('protocol.')
      ? 'protocol'
      : error.code.startsWith('file.')
        ? 'file'
        : fallback
  return new HermesNativeClientError(error.message, kind, error.code, error.retryable)
}

function helloFrame(conversationId: string, installationId: string): string {
  return JSON.stringify({
    type: 'hello', protocol: HERMES_PROTOCOL, versions: [HERMES_PROTOCOL_VERSION],
    client: { name: 'BearCode', version: '1.0.0' }, conversationId, installationId
  })
}

function isHelloAccepted(value: unknown): boolean {
  const event = value as Record<string, unknown>
  return event.type === 'hello.accepted' && event.protocol === HERMES_PROTOCOL && event.version === HERMES_PROTOCOL_VERSION
}

function isHelloRejected(value: unknown): value is { type: string; error: { code: string; message: string; retryable: boolean } } {
  const event = value as { type?: unknown; error?: unknown }
  const error = event.error as Record<string, unknown> | undefined
  return event.type === 'hello.rejected' && typeof error?.code === 'string' && typeof error.message === 'string' && typeof error.retryable === 'boolean'
}

export class HermesNativeTurn {
  private readonly deps: NativeClientDeps
  private readonly sequence = new SequenceGuard()
  private readonly downloadWriter: NativeDownloadWriter
  private readonly pending = new Map<string, Deferred>()
  private readonly downloadIds = new Set<string>()
  private connection: WebSocket | undefined
  private messageChain: Promise<void> = Promise.resolve()
  private result: Promise<'completed' | 'cancelled'> | undefined
  private resolveResult: ((result: 'completed' | 'cancelled') => void) | undefined
  private rejectResult: ((error: Error) => void) | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private cancelTimer: NodeJS.Timeout | undefined
  private lastHeartbeatAt = 0
  private didRetry = false
  private helloComplete = false
  private startedFlow = false
  private cancelled = false
  private settled = false
  private accepted_ = false

  constructor(
    private readonly options: HermesNativeTurnOptions,
    deps: NativeClientDeps = defaultDeps()
  ) {
    this.deps = deps
    this.downloadWriter = new NativeDownloadWriter(deps.userDataDir, options.conversationId)
  }

  get accepted(): boolean {
    return this.accepted_
  }

  run(): Promise<'completed' | 'cancelled'> {
    if (this.result) return this.result
    this.result = new Promise<'completed' | 'cancelled'>((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    this.options.signal.addEventListener('abort', this.cancel, { once: true })
    if (this.options.signal.aborted) this.cancel()
    else this.openConnection()
    return this.result
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): void {
    this.sendControl({ type: 'approval.resolve', version: 1, turnId: this.options.turnId, requestId, decision })
  }

  resolveClarification(requestId: string, response: string): void {
    this.sendControl({ type: 'clarification.resolve', version: 1, turnId: this.options.turnId, requestId, response })
  }

  cancel = (): void => {
    if (this.settled || this.cancelled) return
    this.cancelled = true
    if (!this.accepted_ || !this.connection) {
      this.finish('cancelled')
      return
    }
    try {
      this.sendControl({ type: 'turn.cancel', version: 1, turnId: this.options.turnId })
    } catch (error) {
      this.fail(error)
      return
    }
    this.cancelTimer = setTimeout(() => this.finish('cancelled'), CANCEL_GRACE_MS)
  }

  private openConnection(): void {
    if (this.settled) return
    let connection: WebSocket
    try {
      connection = this.deps.createWebSocket(nativeUrl(this.options.url), {
        headers: { Authorization: `Bearer ${this.options.platformKey}` }
      })
    } catch (error) {
      this.handleConnectionFailure(error)
      return
    }
    this.connection = connection
    connection.on('open', () => {
      if (this.connection !== connection || this.settled) return
      try {
        connection.send(helloFrame(this.options.conversationId, this.options.installationId))
      } catch (error) {
        this.handleConnectionFailure(error)
      }
    })
    connection.on('message', (raw, binary) => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(connection, raw, binary))
        .catch((error: unknown) => this.fail(this.asProtocolError(error)))
    })
    connection.on('error', (error) => this.handleConnectionFailure(error))
    connection.on('close', () => this.handleConnectionClose(connection))
  }

  private async handleMessage(connection: WebSocket, raw: WebSocket.RawData, binary: boolean): Promise<void> {
    if (this.settled || this.connection !== connection) return
    if (binary) {
      await this.handleBinary(asBuffer(raw))
      return
    }
    const payload = asBuffer(raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString())
    } catch {
      throw new HermesNativeClientError('Native Hermes sent invalid JSON', 'protocol', 'protocol.invalid_json')
    }
    const type = (parsed as { type?: unknown }).type
    if (type === 'heartbeat') {
      const heartbeat = parsed as { version?: unknown; nonce?: unknown }
      if (heartbeat.version !== 1 || typeof heartbeat.nonce !== 'string') {
        throw new HermesNativeClientError('Native Hermes sent an invalid heartbeat', 'protocol', 'protocol.invalid_heartbeat')
      }
      this.lastHeartbeatAt = this.deps.now()
      this.sendControl({ type: 'heartbeat', version: 1, nonce: heartbeat.nonce })
      return
    }
    if (!this.helloComplete) {
      if (isHelloAccepted(parsed)) {
        this.helloComplete = true
        this.lastHeartbeatAt = this.deps.now()
        this.startHeartbeatWatch()
        this.startTurnFlow(connection)
        return
      }
      if (isHelloRejected(parsed)) throw errorFromWire(parsed.error)
      throw new HermesNativeClientError('Native Hermes sent an invalid handshake response', 'protocol', 'protocol.invalid_handshake')
    }
    const event = deepFreeze(parseServerEvent(payload))
    // A duplicate is the ledger's alternate response to this client's first
    // turn.start. It carries sequence 1 without a preceding turn.accepted.
    if (event.type !== 'turn.duplicate') this.sequence.accept(event)
    await this.handleServerEvent(event)
  }

  private async handleBinary(frame: Buffer): Promise<void> {
    const chunk = decodeBinaryFrame(frame)
    if (chunk.direction !== 'download' || !this.downloadIds.has(chunk.attachmentId)) {
      throw new HermesNativeClientError('Received binary data without a matching download begin event', 'protocol', 'protocol.unexpected_binary')
    }
    try {
      await this.downloadWriter.append(chunk.attachmentId, chunk.chunkIndex, chunk.payload)
    } catch (error) {
      throw this.asFileError(error)
    }
  }

  private async handleServerEvent(event: HermesServerEvent): Promise<void> {
    if (event.type === 'attachment.upload.accepted') {
      this.resolvePending(`upload.accepted:${event.attachmentId}`)
      return
    }
    if (event.type === 'attachment.upload.completed') {
      this.resolvePending(`upload.completed:${event.attachmentId}`)
      return
    }
    if (event.type === 'attachment.upload.rejected') {
      this.rejectPending(`upload.accepted:${event.attachmentId}`, errorFromWire(event.error, 'file'))
      this.rejectPending(`upload.completed:${event.attachmentId}`, errorFromWire(event.error, 'file'))
      return
    }
    if (event.type === 'attachment.download.begin') {
      try {
        await this.downloadWriter.begin(event.payload.attachment as HermesAttachment)
        this.downloadIds.add(event.payload.attachment.id)
      } catch (error) {
        throw this.asFileError(error)
      }
      this.options.onEvent(event)
      return
    }
    if (event.type === 'attachment.download.completed') {
      if (!this.downloadIds.has(event.payload.attachmentId)) {
        throw new HermesNativeClientError('Download completed without a matching begin event', 'protocol', 'protocol.unexpected_download_completion')
      }
      try {
        const attachment = await this.downloadWriter.complete(event.payload.attachmentId)
        this.downloadIds.delete(event.payload.attachmentId)
        this.options.onEvent(event)
        this.options.onAttachment(attachment)
      } catch (error) {
        throw this.asFileError(error)
      }
      return
    }

    this.options.onEvent(event)
    if (event.type === 'turn.accepted') {
      this.accepted_ = true
      return
    }
    if (event.type === 'turn.duplicate') {
      throw new HermesNativeClientError(
        `Hermes already accepted or finished this turn (${event.payload.status})`,
        'hermes',
        'turn.duplicate',
        false
      )
    }
    if (event.type === 'turn.failed') throw errorFromWire(event.payload.error)
    if (event.type === 'turn.completed') this.finish('completed')
    if (event.type === 'turn.cancelled') this.finish('cancelled')
  }

  private startTurnFlow(connection: WebSocket): void {
    if (this.startedFlow) return
    this.startedFlow = true
    void this.uploadAndStart(connection).catch((error: unknown) => {
      if (this.connection === connection && !this.settled) this.fail(error)
    })
  }

  private async uploadAndStart(connection: WebSocket): Promise<void> {
    for (const attachment of this.options.attachments) {
      if (this.connection !== connection || this.settled) return
      let description: Awaited<ReturnType<typeof describeNativeUpload>>
      try {
        description = await describeNativeUpload(this.deps.userDataDir, this.options.conversationId, attachment)
      } catch (error) {
        throw this.asFileError(error)
      }
      const accepted = this.waitFor(`upload.accepted:${description.id}`)
      this.sendControl({
        type: 'attachment.upload.begin', version: 1, turnId: this.options.turnId,
        attachment: {
          id: description.id, name: description.name, declaredMime: description.declaredMime,
          kind: description.kind, sizeBytes: description.sizeBytes, sha256: description.sha256
        }
      })
      await accepted
      const completed = this.waitFor(`upload.completed:${description.id}`)
      await this.sendUpload(connection, description.path, description.id, description.sizeBytes)
      await completed
    }
    if (this.connection !== connection || this.settled || this.cancelled) return
    this.sendControl({
      type: 'turn.start', version: 1, turnId: this.options.turnId,
      conversationId: this.options.conversationId, text: this.options.text,
      attachmentIds: this.options.attachments.map((attachment) => attachment.id)
    })
  }

  private async sendUpload(
    connection: WebSocket,
    path: string,
    attachmentId: string,
    expectedSize: number
  ): Promise<void> {
    let chunkIndex = 0
    let bytesSent = 0
    for await (const value of createReadStream(path, { highWaterMark: HERMES_MAX_CHUNK_BYTES })) {
      const payload = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytesSent += payload.length
      if (this.connection !== connection || this.settled) {
        throw new HermesNativeClientError('Native Hermes connection closed during upload', 'network', 'network.disconnected')
      }
      connection.send(encodeBinaryFrame({
        direction: 'upload', attachmentId, chunkIndex, final: bytesSent === expectedSize, payload
      }))
      chunkIndex += 1
    }
    if (bytesSent === 0) {
      if (this.connection !== connection || this.settled) {
        throw new HermesNativeClientError('Native Hermes connection closed during upload', 'network', 'network.disconnected')
      }
      connection.send(encodeBinaryFrame({ direction: 'upload', attachmentId, chunkIndex: 0, final: true, payload: Buffer.alloc(0) }))
    }
    if (bytesSent !== expectedSize) {
      throw new HermesNativeClientError('Attachment changed before upload could complete', 'file', 'file.changed_during_upload')
    }
  }

  private waitFor(key: string): Promise<void> {
    if (this.pending.has(key)) throw new HermesNativeClientError('Duplicate pending native client operation', 'protocol', 'protocol.client_state')
    return new Promise<void>((resolve, reject) => this.pending.set(key, { resolve, reject }))
  }

  private resolvePending(key: string): void {
    const pending = this.pending.get(key)
    if (!pending) throw new HermesNativeClientError('Unexpected native upload acknowledgement', 'protocol', 'protocol.unexpected_upload_event')
    this.pending.delete(key)
    pending.resolve()
  }

  private rejectPending(key: string, error: Error): void {
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    pending.reject(error)
  }

  private sendControl(event: unknown): void {
    if (!this.connection || this.settled) {
      throw new HermesNativeClientError('Native Hermes connection is not active', 'network', 'network.disconnected')
    }
    this.connection.send(encodeClientEvent(event))
  }

  private startHeartbeatWatch(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.settled && this.deps.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        this.fail(new HermesNativeClientError('Native Hermes heartbeat timed out', 'network', 'network.disconnected'))
      }
    }, 1000)
  }

  private handleConnectionFailure(error: unknown): void {
    if (this.settled) return
    const message = error instanceof Error ? error.message : 'Native Hermes connection failed'
    if (!this.accepted_ && !this.didRetry) {
      this.didRetry = true
      this.rejectPendingOperations(new HermesNativeClientError(message, 'network', 'network.disconnected'))
      this.helloComplete = false
      this.startedFlow = false
      const previous = this.connection
      this.connection = undefined
      previous?.close()
      this.openConnection()
      return
    }
    this.fail(new HermesNativeClientError(message, 'network', 'network.disconnected'))
  }

  private handleConnectionClose(connection: WebSocket): void {
    if (this.settled || this.connection !== connection) return
    if (this.cancelled) return
    this.handleConnectionFailure(new Error('Native Hermes connection closed'))
  }

  private rejectPendingOperations(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private asFileError(error: unknown): HermesNativeClientError {
    if (error instanceof HermesNativeClientError) return error
    return new HermesNativeClientError(
      error instanceof Error ? error.message : 'Native attachment transfer failed',
      'file',
      'file.transfer_failed'
    )
  }

  private asProtocolError(error: unknown): HermesNativeClientError {
    if (error instanceof HermesNativeClientError) return error
    if (error instanceof ProtocolViolation) {
      return new HermesNativeClientError(error.message, 'protocol', 'protocol.violation')
    }
    return new HermesNativeClientError(
      error instanceof Error ? error.message : 'Native Hermes protocol error',
      'protocol',
      'protocol.violation'
    )
  }

  private finish(result: 'completed' | 'cancelled'): void {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.rejectPendingOperations(new HermesNativeClientError('Native turn ended', 'cancelled', 'turn.cancelled'))
    this.options.signal.removeEventListener('abort', this.cancel)
    void this.downloadWriter.abort()
    this.connection?.close()
    this.resolveResult?.(result)
  }

  private fail(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.rejectPendingOperations(error instanceof Error ? error : new Error(String(error)))
    this.options.signal.removeEventListener('abort', this.cancel)
    void this.downloadWriter.abort()
    this.connection?.close()
    this.rejectResult?.(error instanceof Error ? error : new Error(String(error)))
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.heartbeatTimer = undefined
    this.cancelTimer = undefined
  }
}

export async function checkHermesNativeHealth(
  url: string,
  platformKey: string,
  installationId: string,
  deps: Pick<NativeClientDeps, 'createWebSocket'> = defaultDeps()
): Promise<{ ok: boolean; message: string }> {
  const conversationId = randomUUID()
  return new Promise((resolve) => {
    let complete = false
    const finish = (result: { ok: boolean; message: string }): void => {
      if (complete) return
      complete = true
      socket.close()
      resolve(result)
    }
    let socket: WebSocket
    try {
      socket = deps.createWebSocket(nativeUrl(url), { headers: { Authorization: `Bearer ${platformKey}` } })
    } catch (error) {
      resolve({ ok: false, message: error instanceof Error ? error.message : 'Could not reach native Hermes platform' })
      return
    }
    socket.on('open', () => socket.send(helloFrame(conversationId, installationId)))
    socket.on('message', (raw, binary) => {
      if (binary) return finish({ ok: false, message: 'Incompatible native Hermes protocol' })
      try {
        const event = JSON.parse(asBuffer(raw).toString())
        if (isHelloAccepted(event)) finish({ ok: true, message: 'Connected' })
        else if (isHelloRejected(event)) {
          finish({
            ok: false,
            message: event.error.code.startsWith('auth.')
              ? 'Rejected — check the platform key in Settings'
              : event.error.code.startsWith('protocol.')
                ? 'Incompatible native Hermes protocol'
                : event.error.message
          })
        } else finish({ ok: false, message: 'Incompatible native Hermes protocol' })
      } catch {
        finish({ ok: false, message: 'Incompatible native Hermes protocol' })
      }
    })
    socket.on('error', (error) => finish({ ok: false, message: error.message || 'Could not reach native Hermes platform' }))
    socket.on('close', () => {
      if (!complete) finish({ ok: false, message: 'Could not reach native Hermes platform' })
    })
  })
}
