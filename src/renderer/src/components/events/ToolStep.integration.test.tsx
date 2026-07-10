// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ToolStep } from './ToolStep'
import type { Event, ToolName } from '@shared/types'

afterEach(cleanup)

describe('ToolStep github_/bitbucket_ step cards (Task 11)', () => {
  it('a pending github_ call renders PendingIntegrationAction with allow/deny buttons', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'gh1',
      tool: 'github_create_pr' as ToolName,
      input: { owner: 'acme', repo: 'widgets', title: 'Fix bug', head: 'fix', base: 'main' },
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getAllByText(/GitHub/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/create_pr/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Yes, allow this time/)).toBeTruthy()
    expect(screen.getByText(/No, deny it/)).toBeTruthy()
  })

  it('a pending github_ card renders the call arguments so consent is not blind', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'gh-args',
      tool: 'github_create_pr' as ToolName,
      input: {
        owner: 'acme',
        repo: 'widgets',
        title: 'Delete prod config',
        head: 'x',
        base: 'main'
      },
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getByText(/Delete prod config/)).toBeTruthy()
  })

  it('a pending github_ card with no arguments omits the args block', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'gh-noargs',
      tool: 'github_list_repos' as ToolName,
      input: {},
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getAllByText(/list_repos/).length).toBeGreaterThan(0)
    expect(screen.queryByText('{}')).toBeNull()
  })

  it('a pending bitbucket_ call renders PendingIntegrationAction too', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'bb1',
      tool: 'bitbucket_create_pr' as ToolName,
      input: { workspace: 'acme', repoSlug: 'widgets', title: 'Fix', sourceBranch: 'x' },
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getAllByText(/Bitbucket/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/create_pr/).length).toBeGreaterThan(0)
  })

  it('a denied github_ call renders the denied summary, not the approval card', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'gh2',
      tool: 'github_create_pr' as ToolName,
      input: { owner: 'acme', repo: 'widgets', title: 'x', head: 'x', base: 'main' },
      approvalState: 'denied'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getByText(/Denied/)).toBeTruthy()
    expect(screen.queryByText(/Yes, allow this time/)).toBeNull()
  })

  it('a resolved github_ call renders an expandable step with the result body', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'gh3',
      tool: 'github_list_repos' as ToolName,
      input: {},
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'ghr3',
      callId: 'gh3',
      output: '[]',
      durationMs: 5,
      truncated: false
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    expect(screen.getByText(/github · list_repos/)).toBeTruthy()
  })
})
