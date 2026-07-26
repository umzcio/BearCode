import { z } from 'zod'

export const HERMES_PROTOCOL = 'bearcode-hermes' as const
export const HERMES_PROTOCOL_VERSION = 1 as const
export const HERMES_MAX_FILES = 5
export const HERMES_MAX_FILE_BYTES = 10 * 1024 * 1024
export const HERMES_MAX_CHUNK_BYTES = 256 * 1024

export interface HermesWireError {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, string | number | boolean>
}

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny'
export type BinaryDirection = 'upload' | 'download'

export interface BinaryChunk {
  direction: BinaryDirection
  attachmentId: string
  chunkIndex: number
  final: boolean
  payload: Buffer
}

export class ProtocolViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolViolation'
  }
}

const uuid = z.uuid()
const wireError = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
}).strict()
const attachment = z.object({
  id: uuid, name: z.string(), declaredMime: z.string(), kind: z.string(),
  sizeBytes: z.number().int().min(0).max(HERMES_MAX_FILE_BYTES), sha256: z.string()
}).strict()

const clientSchemas = [
  z.object({ type: z.literal('attachment.upload.begin'), version: z.literal(1), turnId: uuid, attachment }).strict(),
  z.object({ type: z.literal('turn.start'), version: z.literal(1), turnId: uuid, conversationId: uuid, text: z.string(), attachmentIds: z.array(uuid).max(HERMES_MAX_FILES) }).strict(),
  z.object({ type: z.literal('approval.resolve'), version: z.literal(1), turnId: uuid, requestId: uuid, decision: z.enum(['once', 'session', 'always', 'deny']) }).strict(),
  z.object({ type: z.literal('clarification.resolve'), version: z.literal(1), turnId: uuid, requestId: uuid, response: z.string() }).strict(),
  z.object({ type: z.literal('turn.cancel'), version: z.literal(1), turnId: uuid }).strict(),
  z.object({ type: z.literal('heartbeat'), version: z.literal(1), nonce: z.string() }).strict()
] as const
const ClientEventSchema = z.discriminatedUnion('type', clientSchemas)
export type HermesClientEvent = z.infer<typeof ClientEventSchema>

const baseServer = { version: z.literal(1), turnId: uuid }
const sequencedPayload = z.object({ version: z.literal(1), turnId: uuid, sequence: z.number().int().positive(), payload: z.unknown() })
const serverSchemas = [
  z.object({ type: z.literal('attachment.upload.accepted'), ...baseServer, attachmentId: uuid }).strict(),
  z.object({ type: z.literal('attachment.upload.completed'), ...baseServer, attachmentId: uuid }).strict(),
  z.object({ type: z.literal('attachment.upload.rejected'), ...baseServer, attachmentId: uuid, error: wireError }).strict(),
  z.object({ type: z.literal('turn.accepted'), ...sequencedPayload.shape, payload: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('turn.duplicate'), ...sequencedPayload.shape, payload: z.object({ status: z.string() }).strict() }).strict(),
  z.object({ type: z.literal('assistant.started'), ...sequencedPayload.shape, payload: z.object({ messageId: uuid }).strict() }).strict(),
  z.object({ type: z.literal('assistant.delta'), ...sequencedPayload.shape, payload: z.object({ messageId: uuid, text: z.string(), replace: z.literal(true).optional() }).strict() }).strict(),
  z.object({ type: z.literal('assistant.completed'), ...sequencedPayload.shape, payload: z.object({ messageId: uuid }).strict() }).strict(),
  z.object({ type: z.literal('tool.started'), ...sequencedPayload.shape, payload: z.object({ toolCallId: uuid, name: z.string(), label: z.string() }).strict() }).strict(),
  z.object({ type: z.literal('tool.progress'), ...sequencedPayload.shape, payload: z.object({ toolCallId: uuid, label: z.string() }).strict() }).strict(),
  z.object({ type: z.literal('tool.completed'), ...sequencedPayload.shape, payload: z.object({ toolCallId: uuid, status: z.string() }).strict() }).strict(),
  z.object({ type: z.literal('approval.requested'), ...sequencedPayload.shape, payload: z.object({ requestId: uuid, toolCallId: uuid, command: z.string(), description: z.string(), allowSession: z.boolean(), allowPermanent: z.boolean(), smartDenied: z.boolean() }).strict() }).strict(),
  z.object({ type: z.literal('clarification.requested'), ...sequencedPayload.shape, payload: z.object({ requestId: uuid, question: z.string(), choices: z.array(z.string()) }).strict() }).strict(),
  z.object({ type: z.literal('attachment.download.begin'), ...sequencedPayload.shape, payload: z.object({ attachment: z.object({ id: uuid, name: z.string(), mime: z.string(), kind: z.string(), sizeBytes: z.number().int().min(0), sha256: z.string() }).strict() }).strict() }).strict(),
  z.object({ type: z.literal('attachment.download.completed'), ...sequencedPayload.shape, payload: z.object({ attachmentId: uuid }).strict() }).strict(),
  z.object({ type: z.literal('turn.completed'), ...sequencedPayload.shape, payload: z.object({ sessionId: z.string() }).strict() }).strict(),
  z.object({ type: z.literal('turn.failed'), ...sequencedPayload.shape, payload: z.object({ error: wireError }).strict() }).strict(),
  z.object({ type: z.literal('turn.cancelled'), ...sequencedPayload.shape, payload: z.object({}).strict() }).strict()
] as const
const ServerEventSchema = z.discriminatedUnion('type', serverSchemas)
export type HermesServerEvent = z.infer<typeof ServerEventSchema>

function parseJson(raw: string | Buffer): unknown {
  try { return JSON.parse(raw.toString()) } catch { throw new ProtocolViolation('invalid JSON control frame') }
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ProtocolViolation(`invalid protocol event: ${result.error.issues[0]?.message ?? 'schema validation failed'}`)
  return result.data
}

export function encodeClientEvent(event: HermesClientEvent | unknown): string {
  return JSON.stringify(validate(ClientEventSchema, event))
}

export function parseServerEvent(raw: string | Buffer): HermesServerEvent {
  return validate(ServerEventSchema, parseJson(raw))
}

const MAGIC = Buffer.from('BCH1')
const HEADER_BYTES = 32

function binaryUuid(value: string): Buffer {
  if (!uuid.safeParse(value).success) throw new ProtocolViolation('attachmentId must be a UUID')
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

export function encodeBinaryFrame(chunk: BinaryChunk): Buffer {
  if (chunk.direction !== 'upload' && chunk.direction !== 'download') throw new ProtocolViolation('invalid binary direction')
  if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex > 0xffffffff) throw new ProtocolViolation('invalid chunk index')
  if (typeof chunk.final !== 'boolean') throw new ProtocolViolation('final must be a boolean')
  if (!Buffer.isBuffer(chunk.payload) || chunk.payload.length > HERMES_MAX_CHUNK_BYTES) throw new ProtocolViolation('payload exceeds maximum chunk size')
  const frame = Buffer.alloc(HEADER_BYTES + chunk.payload.length)
  MAGIC.copy(frame); frame[4] = HERMES_PROTOCOL_VERSION; frame[5] = chunk.direction === 'upload' ? 1 : 2; frame[6] = chunk.final ? 1 : 0
  binaryUuid(chunk.attachmentId).copy(frame, 8); frame.writeUInt32BE(chunk.chunkIndex, 24); frame.writeUInt32BE(chunk.payload.length, 28); chunk.payload.copy(frame, HEADER_BYTES)
  return frame
}

export function decodeBinaryFrame(frame: Buffer): BinaryChunk {
  if (!Buffer.isBuffer(frame) || frame.length < HEADER_BYTES) throw new ProtocolViolation('binary frame is shorter than header')
  if (!frame.subarray(0, 4).equals(MAGIC)) throw new ProtocolViolation('invalid binary frame magic')
  if (frame[4] !== HERMES_PROTOCOL_VERSION) throw new ProtocolViolation('unsupported binary frame version')
  if (frame[5] !== 1 && frame[5] !== 2) throw new ProtocolViolation('invalid binary direction')
  if ((frame[6] & ~1) !== 0 || frame[7] !== 0) throw new ProtocolViolation('reserved binary frame flags')
  const length = frame.readUInt32BE(28); const payload = frame.subarray(HEADER_BYTES)
  if (length !== payload.length) throw new ProtocolViolation('binary payload length mismatch')
  if (length > HERMES_MAX_CHUNK_BYTES) throw new ProtocolViolation('payload exceeds maximum chunk size')
  const hex = frame.subarray(8, 24).toString('hex'); const attachmentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return { direction: frame[5] === 1 ? 'upload' : 'download', attachmentId, chunkIndex: frame.readUInt32BE(24), final: Boolean(frame[6] & 1), payload: Buffer.from(payload) }
}

export class SequenceGuard {
  private expected = new Map<string, number>()

  accept(event: HermesServerEvent): void {
    if (!('sequence' in event)) return
    if (event.type === 'turn.accepted') {
      if (event.sequence !== 1 || this.expected.has(event.turnId)) throw new ProtocolViolation('invalid turn acceptance sequence')
      this.expected.set(event.turnId, 2); return
    }
    const expected = this.expected.get(event.turnId)
    if (expected === undefined || event.sequence !== expected) throw new ProtocolViolation('server sequence is not contiguous')
    this.expected.set(event.turnId, expected + 1)
  }
}
