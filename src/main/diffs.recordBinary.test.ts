import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
const writes: { path: string; bytes: number }[] = []
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: Buffer) => writes.push({ path: p, bytes: data.length })),
    existsSync: vi.fn(() => false)
  }
})
const runCalls: unknown[][] = []
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return { pragma: vi.fn(), exec: vi.fn(), prepare: vi.fn(() => ({ run: (...a: unknown[]) => runCalls.push(a), all: () => [], get: () => undefined })) }
  })
}))

import { recordBinaryCreation } from './diffs'

beforeEach(() => {
  writes.length = 0
  runCalls.length = 0
})

describe('recordBinaryCreation', () => {
  it('writes the buffer and records a created diff row with the marker', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
    const f = recordBinaryCreation('g1', 'c1', '/ws/out.docx', buf, '(binary: docx, 5 bytes)')
    expect(writes).toEqual([{ path: '/ws/out.docx', bytes: 5 }])
    expect(f.status).toBe('created')
    expect(f.afterText).toBe('(binary: docx, 5 bytes)')
    // the INSERT ran with before_text '' and after_text = marker
    const insert = runCalls.find((a) => typeof a[3] === 'string' && a[3] === '')
    expect(insert).toBeTruthy()
  })
})
