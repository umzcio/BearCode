import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeClientEvent,
  parseServerEvent,
  ProtocolViolation,
  SequenceGuard
} from './protocol'

// Canonical wire-protocol test vectors -- also mirrored in the Hermes-side
// gateway plugin repo (github.com/umzcio/bearcode-hermes, fixtures/protocol-v1/)
// so both ends of the protocol validate against the same fixtures without a
// cross-repo checkout at test time.
const fixtureDir = resolve(__dirname, 'fixtures/protocol-v1')
const binary = JSON.parse(readFileSync(resolve(fixtureDir, 'binary.json'), 'utf8'))
const events = JSON.parse(readFileSync(resolve(fixtureDir, 'events.json'), 'utf8'))

describe('Hermes protocol V1', () => {
  it('matches the canonical binary fixture byte-for-byte', () => {
    const frame = encodeBinaryFrame({ direction: 'upload', attachmentId: binary.attachmentId, chunkIndex: 0, final: true, payload: Buffer.from(binary.payloadHex, 'hex') })
    expect(frame.toString('hex')).toBe(binary.headerHex + binary.payloadHex)
    expect(decodeBinaryFrame(frame)).toMatchObject({ direction: 'upload', attachmentId: binary.attachmentId, chunkIndex: 0, final: true })
  })

  it('parses every server fixture', () => {
    for (const event of events.serverEvents) expect(parseServerEvent(JSON.stringify(event))).toEqual(event)
  })

  it('encodes every client fixture', () => {
    for (const event of events.clientEvents) expect(JSON.parse(encodeClientEvent(event))).toEqual(event)
  })

  it('rejects malformed JSON and unsupported protocol versions', () => {
    expect(() => parseServerEvent('{')).toThrow(ProtocolViolation)
    expect(() => encodeClientEvent({ type: 'heartbeat', version: 2, nonce: 'x' })).toThrow(ProtocolViolation)
  })

  it('rejects invalid UUIDs in fully shaped client events', () => {
    const invalidFields: Array<[string, string[]]> = [
      ['attachment.upload.begin', ['attachment', 'id']],
      ['turn.start', ['turnId']],
      ['turn.start', ['conversationId']],
      ['turn.start', ['attachmentIds', '0']],
      ['approval.resolve', ['requestId']],
      ['clarification.resolve', ['requestId']],
      ['turn.cancel', ['turnId']]
    ]
    for (const [type, path] of invalidFields) {
      const event = structuredClone(events.clientEvents.find((candidate: { type: string }) => candidate.type === type)) as Record<string, unknown>
      let target: Record<string, unknown> | unknown[] = event
      for (const key of path.slice(0, -1)) target = Array.isArray(target) ? target[Number(key)] as Record<string, unknown> : target[key] as Record<string, unknown>
      if (Array.isArray(target)) target[Number(path.at(-1))] = 'not-a-uuid'
      else target[path.at(-1) as string] = 'not-a-uuid'
      expect(() => encodeClientEvent(event)).toThrow(ProtocolViolation)
    }
  })

  it('rejects bad magic, reserved flags, lengths, and oversize chunks', () => {
    const raw = Buffer.from(binary.headerHex + binary.payloadHex, 'hex')
    for (const frame of [Buffer.concat([Buffer.from('NOPE'), raw.subarray(4)]), Buffer.concat([raw.subarray(0, 6), Buffer.from([2]), raw.subarray(7)]), raw.subarray(0, raw.length - 1)]) expect(() => decodeBinaryFrame(frame)).toThrow(ProtocolViolation)
    expect(() => encodeBinaryFrame({ direction: 'upload', attachmentId: binary.attachmentId, chunkIndex: 0, final: true, payload: Buffer.alloc(262145) })).toThrow(ProtocolViolation)
  })

  it('rejects a non-boolean binary final flag', () => {
    expect(() => encodeBinaryFrame({ direction: 'upload', attachmentId: binary.attachmentId, chunkIndex: 0, final: 'yes' as unknown as boolean, payload: Buffer.alloc(0) })).toThrow(ProtocolViolation)
  })

  it('requires contiguous server sequences after turn acceptance', () => {
    const guard = new SequenceGuard()
    expect(() => guard.accept(events.serverEvents[0])).not.toThrow()
    expect(() => guard.accept(events.serverEvents[3])).not.toThrow()
    expect(() => guard.accept(events.serverEvents[3])).toThrow(ProtocolViolation)
    expect(() => guard.accept(events.serverEvents[6])).toThrow(ProtocolViolation)
  })
})
