// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from './store'

beforeEach(() => {
  useAppStore.setState({ view: { kind: 'home' } })
})

describe('openProjectPage', () => {
  it('switches to the project view for a real folder path and closes any aux pane', () => {
    useAppStore.setState({ auxSelection: { kind: 'artifact', artifactId: 'a' } })
    useAppStore.getState().openProjectPage('/Users/zach/Projects/ClaudeU-test')
    expect(useAppStore.getState().view).toEqual({
      kind: 'project',
      path: '/Users/zach/Projects/ClaudeU-test'
    })
    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('accepts a null path for the "No folder" bucket', () => {
    useAppStore.getState().openProjectPage(null)
    expect(useAppStore.getState().view).toEqual({ kind: 'project', path: null })
  })
})
