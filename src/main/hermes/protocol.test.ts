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

const fixtureDir = resolve(process.cwd(), 'integrations/hermes-bearcode/fixtures/protocol-v1')
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

  it('rejects bad magic, reserved flags, lengths, and oversize chunks', () => {
    const raw = Buffer.from(binary.headerHex + binary.payloadHex, 'hex')
    for (const frame of [Buffer.concat([Buffer.from('NOPE'), raw.subarray(4)]), Buffer.concat([raw.subarray(0, 6), Buffer.from([2]), raw.subarray(7)]), raw.subarray(0, raw.length - 1)]) expect(() => decodeBinaryFrame(frame)).toThrow(ProtocolViolation)
    expect(() => encodeBinaryFrame({ direction: 'upload', attachmentId: binary.attachmentId, chunkIndex: 0, final: true, payload: Buffer.alloc(262145) })).toThrow(ProtocolViolation)
  })

  it('requires contiguous server sequences after turn acceptance', () => {
    const guard = new SequenceGuard()
    expect(() => guard.accept(events.serverEvents[0])).not.toThrow()
    expect(() => guard.accept(events.serverEvents[3])).not.toThrow()
    expect(() => guard.accept(events.serverEvents[3])).toThrow(ProtocolViolation)
    expect(() => guard.accept(events.serverEvents[6])).toThrow(ProtocolViolation)
  })
})
