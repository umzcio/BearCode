// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ToolStep } from './ToolStep'
import type { Event, ToolName } from '@shared/types'

afterEach(cleanup)

describe('ToolStep mcp__ step cards', () => {
  it('a pending mcp__ call renders PendingMcpAction with allow/deny buttons', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'mc1',
      tool: 'mcp__github__get_issue' as ToolName,
      input: { issue_number: 42 },
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getAllByText(/github/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/get_issue/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Yes, allow this time/)).toBeTruthy()
    expect(screen.getByText(/No, deny it/)).toBeTruthy()
  })

  it('a pending mcp__ card renders the call arguments so consent is not blind', () => {
    // Whole-branch review finding 3: the Ask card must show the args, not just
    // the tool name -- otherwise a fs · write_file to /etc/hosts is approved
    // without seeing the destructive target/content.
    const call: Event = {
      type: 'tool_call',
      id: 'mc-args',
      tool: 'mcp__fs__write_file' as ToolName,
      input: { path: '/etc/hosts', content: '127.0.0.1 evil.example' },
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    // Both the sensitive path and content are visible in the card.
    expect(screen.getByText(/\/etc\/hosts/)).toBeTruthy()
    expect(screen.getByText(/evil\.example/)).toBeTruthy()
  })

  it('a pending mcp__ card with no arguments omits the args block', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'mc-noargs',
      tool: 'mcp__github__list_repos' as ToolName,
      input: {},
      approvalState: 'pending'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    // The tool name still renders; no empty {} args block is shown.
    expect(screen.getAllByText(/list_repos/).length).toBeGreaterThan(0)
    expect(screen.queryByText('{}')).toBeNull()
  })

  it('a resolved mcp__ call renders an expandable step with the result body', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'mc2',
      tool: 'mcp__github__get_issue' as ToolName,
      input: { issue_number: 42 },
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'mr2',
      callId: 'mc2',
      output: 'Issue #42: fix the thing',
      durationMs: 5,
      truncated: false
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    expect(screen.getByText(/github · get_issue/)).toBeTruthy()
  })

  it('summaryFor yields a readable "server · tool" label', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'mc3',
      tool: 'mcp__linear__create_issue' as ToolName,
      input: {},
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'mr3',
      callId: 'mc3',
      output: 'created',
      durationMs: 5,
      truncated: false
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    expect(screen.getByText(/linear · create_issue/)).toBeTruthy()
  })
})
