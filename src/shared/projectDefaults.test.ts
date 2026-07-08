import { describe, it, expect } from 'vitest'
import { resolveProjectDefaults } from './projectDefaults'
import type { Project } from './types'

const global = {
  defaultModelRef: 'anthropic/claude-opus-4-8',
  defaultEffort: 'adaptive' as const,
  defaultPermissionMode: 'accept-edits' as const
}

const project = (over: Partial<Project>): Project => ({
  id: 'p1',
  name: 'P',
  color: null,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('resolveProjectDefaults', () => {
  it('no project → all global', () => {
    expect(resolveProjectDefaults(null, global)).toEqual({
      modelRef: 'anthropic/claude-opus-4-8',
      effort: 'adaptive',
      permissionMode: 'accept-edits'
    })
  })

  it('project override wins per field', () => {
    expect(
      resolveProjectDefaults(
        project({
          defaultModelRef: 'openai/gpt-5.1',
          defaultEffort: 'high',
          defaultPermissionMode: 'plan'
        }),
        global
      )
    ).toEqual({ modelRef: 'openai/gpt-5.1', effort: 'high', permissionMode: 'plan' })
  })

  it('unset project fields fall back to global (mixed)', () => {
    expect(resolveProjectDefaults(project({ defaultEffort: 'max' }), global)).toEqual({
      modelRef: 'anthropic/claude-opus-4-8',
      effort: 'max',
      permissionMode: 'accept-edits'
    })
  })

  it('null project fields (cleared overrides) fall back to global', () => {
    expect(
      resolveProjectDefaults(
        project({ defaultModelRef: null, defaultEffort: null, defaultPermissionMode: null }),
        global
      )
    ).toEqual({
      modelRef: 'anthropic/claude-opus-4-8',
      effort: 'adaptive',
      permissionMode: 'accept-edits'
    })
  })

  it('a null global model with no project override resolves to null', () => {
    expect(
      resolveProjectDefaults(null, { ...global, defaultModelRef: null }).modelRef
    ).toBeNull()
  })
})
