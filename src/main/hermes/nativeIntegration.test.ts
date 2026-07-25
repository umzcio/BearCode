import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AttachmentRef, HermesAttachment } from '../../shared/types'
import {
  HermesNativeClientError,
  HermesNativeTurn
} from './nativeClient'
import type {
  ApprovalDecision,
  HermesServerEvent
} from './protocol'

const PLATFORM_KEY = 'integration-secret'
const INSTALLATION_ID = '22222222-2222-4222-8222-222222222222'
const READY_TIMEOUT_MS = 10_000
const TURN_TIMEOUT_MS = 10_000
const CHILD_EXIT_TIMEOUT_MS = 5_000
const UPLOAD_BYTES = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21])
const UPLOAD_SHA256 = '334d016f755cd6dc58c53a86e183882f8ec14f52fb05345887c8a5edd42c87b7'
const DOWNLOAD_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46])
const DOWNLOAD_SHA256 = '315d429b7714cedb6ad04ac31240145257692630457f3c88253c5beceac76027'
const DOWNLOAD_ATTACHMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

interface ActiveTurn {
  controller: AbortController
  result: Promise<'completed' | 'cancelled'>
}

interface TurnHarness {
  turn: HermesNativeTurn
  result: Promise<'completed' | 'cancelled'>
  events: HermesServerEvent[]
  attachments: HermesAttachment[]
  conversationId: string
}

let child: ReturnType<typeof spawn> | undefined
let childOutput = ''
let childStderr = ''
let readyLineCount = 0
const unexpectedStdout: string[] = []
let port = 0
let userDataDir = ''
const activeTurns = new Set<ActiveTurn>()

function diagnostics(): string {
  return childOutput.replaceAll(PLATFORM_KEY, '[REDACTED]').trim()
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms\n${diagnostics()}`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port')
    return address.port
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function waitForReady(process: ReturnType<typeof spawn>): Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    let stdout = ''
    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString()
      stdout += text
      childOutput += `[stdout] ${text}`
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (line === 'READY') readyLineCount += 1
        else if (line.length > 0) {
          unexpectedStdout.push(line)
          reject(new Error(`Unexpected harness stdout line: ${line}`))
        }
      }
      if (readyLineCount === 1) resolve()
      if (readyLineCount > 1) reject(new Error('Harness emitted READY more than once'))
    }
    const onStderr = (chunk: Buffer): void => {
      const text = chunk.toString()
      childStderr += text
      childOutput += `[stderr] ${text}`
    }
    const onError = (error: Error): void => reject(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      reject(new Error(`Harness exited before READY (code=${String(code)}, signal=${String(signal)})\n${diagnostics()}`))
    }
    process.stdout?.on('data', onStdout)
    process.stderr?.on('data', onStderr)
    process.once('error', onError)
    process.once('exit', onExit)
  }), READY_TIMEOUT_MS, 'Harness readiness')
}

async function stopChild(): Promise<void> {
  if (!child) return
  const process = child
  child = undefined
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve({ code: process.exitCode, signal: process.signalCode })
    } else {
      process.once('exit', (code, signal) => resolve({ code, signal }))
    }
  })
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGTERM')
  let status: Awaited<typeof exited>
  try {
    status = await withTimeout(exited, CHILD_EXIT_TIMEOUT_MS, 'Harness termination')
  } catch (error) {
    process.kill('SIGKILL')
    await withTimeout(exited, CHILD_EXIT_TIMEOUT_MS, 'Forced harness termination')
    throw error
  }
  if (status.code !== 0 || status.signal !== null) {
    throw new Error(
      `Harness did not exit cleanly (code=${String(status.code)}, signal=${String(status.signal)})\n${diagnostics()}`
    )
  }
}

function startTurn(
  text: string,
  options: {
    attachments?: AttachmentRef[]
    platformKey?: string
    onEvent?: (event: HermesServerEvent, turn: HermesNativeTurn) => void
  } = {}
): TurnHarness {
  const conversationId = randomUUID()
  const turnId = randomUUID()
  const controller = new AbortController()
  const events: HermesServerEvent[] = []
  const attachments: HermesAttachment[] = []
  let turn!: HermesNativeTurn
  turn = new HermesNativeTurn({
    url: `ws://127.0.0.1:${port}`,
    platformKey: options.platformKey ?? PLATFORM_KEY,
    installationId: INSTALLATION_ID,
    conversationId,
    turnId,
    text,
    attachments: options.attachments ?? [],
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event)
      options.onEvent?.(event, turn)
    },
    onAttachment: (attachment) => attachments.push(attachment)
  }, {
    createWebSocket: (url, socketOptions) => new WebSocket(url, socketOptions),
    userDataDir,
    now: () => Date.now()
  })
  const rawResult = turn.run()
  const active = { controller, result: rawResult }
  activeTurns.add(active)
  void rawResult.finally(() => activeTurns.delete(active)).catch(() => {})
  return {
    turn,
    result: withTimeout(rawResult, TURN_TIMEOUT_MS, `Turn ${text}`),
    events,
    attachments,
    conversationId
  }
}

function eventOf<T extends HermesServerEvent['type']>(
  events: HermesServerEvent[],
  type: T
): Extract<HermesServerEvent, { type: T }> | undefined {
  return events.find((event) => event.type === type) as
    | Extract<HermesServerEvent, { type: T }>
    | undefined
}

async function waitForEvent<T extends HermesServerEvent['type']>(
  events: HermesServerEvent[],
  type: T
): Promise<Extract<HermesServerEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const event = eventOf(events, type)
      if (event) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve(event)
      }
    }, 5)
    const timer = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`Event ${type} timed out after ${TURN_TIMEOUT_MS}ms\n${diagnostics()}`))
    }, TURN_TIMEOUT_MS)
  })
}

async function rejectBadBearer(): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/bearcode`, {
    headers: { Authorization: 'Bearer wrong-integration-secret' }
  })
  try {
    return await withTimeout(new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0
        response.resume()
        resolve(status)
      })
      socket.once('open', () => {
        reject(new Error('Bad bearer unexpectedly upgraded to WebSocket'))
      })
      socket.once('error', (error) => reject(error))
    }), TURN_TIMEOUT_MS, 'Bad bearer rejection')
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
}

async function abortActiveTurns(label: string): Promise<void> {
  const turns = [...activeTurns]
  for (const active of turns) active.controller.abort()
  const outcomes = await Promise.allSettled(
    turns.map((active) => withTimeout(active.result, TURN_TIMEOUT_MS, label))
  )
  const failed = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  )
  if (failed) throw failed.reason
}

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'bearcode-native-integration-'))
  port = await freeLoopbackPort()
  child = spawn('integrations/hermes-bearcode/.venv/bin/python', [
    'integrations/hermes-bearcode/tests/harness_server.py'
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: 'integrations/hermes-bearcode',
      BEARCODE_TEST_PORT: String(port),
      BEARCODE_PLATFORM_KEY: PLATFORM_KEY
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    await waitForReady(child)
  } catch (error) {
    await stopChild()
    throw error
  }
})

afterEach(async () => {
  await abortActiveTurns('Active turn cleanup')
})

afterAll(async () => {
  try {
    await abortActiveTurns('Final turn cleanup')
  } finally {
    try {
      await stopChild()
    } finally {
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
    }
  }
  if (readyLineCount !== 1) throw new Error(`Harness emitted READY ${readyLineCount} times`)
  if (unexpectedStdout.length > 0) {
    throw new Error(`Harness emitted unexpected stdout\n${diagnostics()}`)
  }
  if (childStderr.trim().length > 0) {
    throw new Error(`Harness emitted stderr\n${diagnostics()}`)
  }
})

describe('real Hermes native cross-language integration', () => {
  it('rejects an incorrect bearer before WebSocket upgrade', async () => {
    await expect(rejectBadBearer()).resolves.toBe(401)
  })

  it('streams literal text through the real Python protocol and TypeScript client', async () => {
    const harness = startTurn('text')

    await expect(harness.result).resolves.toBe('completed')
    expect(harness.events.map((event) => event.type)).toEqual([
      'turn.accepted',
      'assistant.started',
      'assistant.delta',
      'assistant.delta',
      'assistant.completed',
      'turn.completed'
    ])
    expect(harness.events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text)).toEqual(['Hel', 'lo'])
  })

  it('carries tool lifecycle events with literal payloads', async () => {
    const harness = startTurn('tool')

    await expect(harness.result).resolves.toBe('completed')
    expect(eventOf(harness.events, 'tool.started')?.payload).toMatchObject({
      name: 'integration-tool',
      label: 'Starting integration tool'
    })
    expect(eventOf(harness.events, 'tool.completed')?.payload).toMatchObject({
      status: 'completed'
    })
  })

  it('resolves approval only after the real request event arrives', async () => {
    const harness = startTurn('approve')
    const requested = await waitForEvent(harness.events, 'approval.requested')

    expect(requested.payload).toMatchObject({
      command: 'printf approved',
      allowSession: true,
      allowPermanent: false,
      smartDenied: false
    })
    harness.turn.resolveApproval(requested.payload.requestId, 'once' satisfies ApprovalDecision)
    await expect(harness.result).resolves.toBe('completed')
    expect(harness.events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text)).toEqual(['approved:once'])
  })

  it('resolves clarification only after the real request event arrives', async () => {
    const harness = startTurn('clarify')
    const requested = await waitForEvent(harness.events, 'clarification.requested')

    expect(requested.payload).toEqual({
      requestId: requested.payload.requestId,
      question: 'Which path?',
      choices: ['alpha', 'beta']
    })
    harness.turn.resolveClarification(requested.payload.requestId, 'beta')
    await expect(harness.result).resolves.toBe('completed')
    expect(harness.events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text)).toEqual(['clarified:beta'])
  })

  it('uploads and verifies the real cached bytes, digest, and name', async () => {
    const conversationId = randomUUID()
    const attachmentId = randomUUID()
    await mkdir(join(userDataDir, 'attachments', conversationId), { recursive: true })
    await writeFile(join(userDataDir, 'attachments', conversationId, attachmentId), UPLOAD_BYTES)
    const controller = new AbortController()
    const events: HermesServerEvent[] = []
    const turn = new HermesNativeTurn({
      url: `ws://127.0.0.1:${port}`,
      platformKey: PLATFORM_KEY,
      installationId: INSTALLATION_ID,
      conversationId,
      turnId: randomUUID(),
      text: 'upload',
      attachments: [{
        id: attachmentId,
        name: 'fixture.txt',
        mime: 'text/plain',
        kind: 'text'
      }],
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      onAttachment: () => {}
    }, {
      createWebSocket: (url, socketOptions) => new WebSocket(url, socketOptions),
      userDataDir,
      now: () => Date.now()
    })
    const rawResult = turn.run()
    const active = { controller, result: rawResult }
    activeTurns.add(active)
    void rawResult.finally(() => activeTurns.delete(active)).catch(() => {})

    await expect(withTimeout(rawResult, TURN_TIMEOUT_MS, 'Upload turn')).resolves.toBe('completed')
    expect(events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text)).toEqual([
      `upload:fixture.txt:${UPLOAD_SHA256}:6`
    ])
  })

  it('downloads exact bytes to the canonical path and reports metadata', async () => {
    const harness = startTurn('download')

    await expect(harness.result).resolves.toBe('completed')
    expect(harness.attachments).toEqual([{
      id: DOWNLOAD_ATTACHMENT_ID,
      name: 'analysis.pdf',
      mime: 'text/plain',
      kind: 'document',
      sizeBytes: 4,
      sha256: DOWNLOAD_SHA256
    }])
    expect(await readFile(join(
      userDataDir,
      'attachments',
      harness.conversationId,
      DOWNLOAD_ATTACHMENT_ID
    ))).toEqual(DOWNLOAD_BYTES)
  })

  it('sends real cancellation only after turn acceptance and settles cancelled', async () => {
    const harness = startTurn('cancel')
    await waitForEvent(harness.events, 'turn.accepted')

    expect(harness.turn.accepted).toBe(true)
    harness.turn.cancel()
    await expect(harness.result).resolves.toBe('cancelled')
    expect(harness.events.map((event) => event.type)).toEqual([
      'turn.accepted',
      'turn.cancelled'
    ])
  })

  it('preserves a partial delta before rejecting once with the typed Hermes error', async () => {
    const harness = startTurn('fail')

    await expect(harness.result).rejects.toEqual(expect.objectContaining({
      name: 'HermesNativeClientError',
      kind: 'hermes',
      code: 'hermes.integration_failure',
      retryable: false
    } satisfies Partial<HermesNativeClientError>))
    expect(harness.events.map((event) => event.type)).toEqual([
      'turn.accepted',
      'assistant.started',
      'assistant.delta',
      'turn.failed'
    ])
    expect(eventOf(harness.events, 'assistant.delta')?.payload.text).toBe('partial')
    expect(harness.events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
  })
})
