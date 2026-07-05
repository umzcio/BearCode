import { describe, it, expect, vi } from 'vitest'

// index.ts imports from '../db' and './graph' (and re-exports pruneCheckpoints
// from './checkpointer') at module load; mock all three so importing the
// module under test never opens a real database or loads the heavy
// deepagents/langchain graph (same pattern as resume.test.ts).
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  getConversationMeta: vi.fn(() => null),
  getEvents: vi.fn(() => []),
  getZombieRunIds: vi.fn(() => []),
  listConversations: vi.fn(() => []),
  setModelRef: vi.fn()
}))

vi.mock('./graph', () => ({
  cancelPendingApproval: vi.fn(),
  clearAllPendingApprovals: vi.fn(),
  forgetPendingApproval: vi.fn(),
  rehydratePausedRun: vi.fn(),
  resolveInterrupt: vi.fn(),
  resolvePlanInterrupt: vi.fn(),
  runGraph: vi.fn(),
  setOnResumeSettled: vi.fn()
}))

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple: vi.fn() }),
  pruneCheckpoints: vi.fn()
}))

import { assertValidPlanReviewResolution } from './index'

// bearcode:artifacts:resolve-plan-review (ipc.ts) validates before calling
// resolvePlanReviewOrchestrator, closing the truthy-coercion exposure at
// graph.ts:1451 (resolvePlanInterrupt branches on `decision.proceed`
// directly). This pins the wire-boundary guard itself, since IPC arguments
// have no runtime type enforcement despite the handler's TS signature.
describe('assertValidPlanReviewResolution', () => {
  it('accepts proceed: true with no message', () => {
    expect(() => assertValidPlanReviewResolution(true, undefined)).not.toThrow()
  })

  it('accepts proceed: false with a string message', () => {
    expect(() => assertValidPlanReviewResolution(false, 'looks good')).not.toThrow()
  })

  it.each([1, 0, 'true', 'false', 'yes', null, undefined, {}, []])(
    'rejects truthy-ish/falsy-ish non-boolean proceed: %p',
    (proceed) => {
      expect(() => assertValidPlanReviewResolution(proceed, undefined)).toThrow(
        /proceed must be a boolean/
      )
    }
  )

  it.each([123, null, {}, [], true])('rejects a non-string message: %p', (message) => {
    expect(() => assertValidPlanReviewResolution(true, message)).toThrow(
      /message must be a string or undefined/
    )
  })
})
