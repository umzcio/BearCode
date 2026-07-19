// Ursa Phase 2 (Task 1): unit tests for the ursa_pipeline persistence
// accessors (setUrsaPipeline / getUrsaPipeline / advanceUrsaPipeline /
// setUrsaPipelineStatus). better-sqlite3 can't load under plain-Node vitest,
// so it's mocked with a minimal in-memory ursa_pipeline table (same precedent
// as ursaContext.test.ts) real enough to round-trip the accessors against a
// fake that honors the actual queries they issue.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('../settings', () => ({
  getSettings: () => ({ defaultEffort: 'adaptive', defaultThinking: true })
}))

interface PipelineRow {
  conversation_id: string
  steps_json: string
  status: string
  current_step: number
  call_id: string
}

let pipelines: Map<string, PipelineRow> = new Map()

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        run: vi.fn((...args: unknown[]) => {
          if (/INSERT INTO ursa_pipeline/.test(sql)) {
            const [conversationId, stepsJson, callId] = args as [string, string, string]
            pipelines.set(conversationId, {
              conversation_id: conversationId,
              steps_json: stepsJson,
              status: 'proposed',
              current_step: 0,
              call_id: callId
            })
            return
          }
          if (/UPDATE ursa_pipeline SET current_step = current_step \+ 1/.test(sql)) {
            const [conversationId] = args as [string]
            const row = pipelines.get(conversationId)
            if (row) row.current_step += 1
            return
          }
          if (/UPDATE ursa_pipeline SET status = \?/.test(sql)) {
            const [status, conversationId] = args as [string, string]
            const row = pipelines.get(conversationId)
            if (row) row.status = status
            return
          }
          // Other statements (e.g. createConversation's INSERT INTO
          // conversations) are irrelevant to these tests -- no-op.
        }),
        get: vi.fn((...args: unknown[]) => {
          if (/FROM ursa_pipeline WHERE conversation_id = \?/.test(sql)) {
            const [conversationId] = args as [string]
            return pipelines.get(conversationId)
          }
          return undefined
        }),
        all: vi.fn(() => [])
      }))
    }
  })
}))

import * as db from './index'

beforeEach(() => {
  pipelines = new Map()
})

describe('ursa_pipeline accessors', () => {
  const steps: db.UrsaPipelineStep[] = [
    { role: 'researcher', modelRef: 'anthropic:claude-sonnet-5', subtask: 'research the API' },
    { role: 'coder', modelRef: 'openai:gpt-5.6-sol', subtask: 'implement it' }
  ]

  it('round-trips a proposed pipeline', () => {
    const id = db.createConversation('/p').id
    db.setUrsaPipeline(id, steps, 'call-1')
    const record = db.getUrsaPipeline(id)
    expect(record).toEqual({
      conversationId: id,
      steps,
      status: 'proposed',
      currentStep: 0,
      callId: 'call-1'
    })
  })

  it('advanceUrsaPipeline increments current_step', () => {
    const id = db.createConversation('/p').id
    db.setUrsaPipeline(id, steps, 'call-1')
    db.advanceUrsaPipeline(id)
    expect(db.getUrsaPipeline(id)?.currentStep).toBe(1)
    db.advanceUrsaPipeline(id)
    expect(db.getUrsaPipeline(id)?.currentStep).toBe(2)
  })

  it('setUrsaPipelineStatus transitions status through the lifecycle', () => {
    const id = db.createConversation('/p').id
    db.setUrsaPipeline(id, steps, 'call-1')
    db.setUrsaPipelineStatus(id, 'running')
    expect(db.getUrsaPipeline(id)?.status).toBe('running')
    db.setUrsaPipelineStatus(id, 'done')
    expect(db.getUrsaPipeline(id)?.status).toBe('done')
  })

  it('setUrsaPipelineStatus supports declined and stopped terminal states', () => {
    const id = db.createConversation('/p').id
    db.setUrsaPipeline(id, steps, 'call-1')
    db.setUrsaPipelineStatus(id, 'declined')
    expect(db.getUrsaPipeline(id)?.status).toBe('declined')

    const id2 = db.createConversation('/p').id
    db.setUrsaPipeline(id2, steps, 'call-2')
    db.setUrsaPipelineStatus(id2, 'stopped')
    expect(db.getUrsaPipeline(id2)?.status).toBe('stopped')
  })

  it('getUrsaPipeline returns undefined for a conversation with no pipeline row', () => {
    const id = db.createConversation('/p').id
    expect(db.getUrsaPipeline(id)).toBeUndefined()
  })

  it('setUrsaPipeline replaces a prior pipeline for the same conversation, resetting status/current_step', () => {
    const id = db.createConversation('/p').id
    db.setUrsaPipeline(id, steps, 'call-1')
    db.advanceUrsaPipeline(id)
    db.setUrsaPipelineStatus(id, 'running')
    expect(db.getUrsaPipeline(id)?.currentStep).toBe(1)

    const newSteps: db.UrsaPipelineStep[] = [
      { role: 'reviewer', modelRef: 'anthropic:claude-sonnet-5', subtask: 'review the PR' }
    ]
    db.setUrsaPipeline(id, newSteps, 'call-2')
    const record = db.getUrsaPipeline(id)
    expect(record).toEqual({
      conversationId: id,
      steps: newSteps,
      status: 'proposed',
      currentStep: 0,
      callId: 'call-2'
    })
  })
})
