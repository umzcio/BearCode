// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ToolStep } from './ToolStep'
import type { Event } from '@shared/types'

afterEach(cleanup)

describe('ToolStep Cmd-open file names', () => {
  it('write_file step: Cmd-click on the file name calls openFile, not openReviewForFile', () => {
    const openFile = vi.fn()
    const openReviewForFile = vi.fn()
    useAppStore.setState({
      openFile: openFile as never,
      openReviewForFile: openReviewForFile as never
    })

    const call: Event = {
      type: 'tool_call',
      id: 'c1',
      tool: 'write_file',
      input: { path: '/Users/zach/proj/foo.ts' },
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'r1',
      callId: 'c1',
      output: '',
      durationMs: 1,
      truncated: false,
      stats: { path: '/Users/zach/proj/foo.ts', status: 'created', additions: 3, deletions: 0 }
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    const chip = screen.getByText('foo.ts')
    expect(chip.className).toContain('step-file')

    fireEvent.click(chip, { metaKey: true })
    expect(openFile).toHaveBeenCalledWith('/Users/zach/proj/foo.ts')
    expect(openReviewForFile).not.toHaveBeenCalled()
  })

  it('write_file step: plain click on the row still calls openReviewForFile', () => {
    const openFile = vi.fn()
    const openReviewForFile = vi.fn()
    useAppStore.setState({
      openFile: openFile as never,
      openReviewForFile: openReviewForFile as never
    })

    const call: Event = {
      type: 'tool_call',
      id: 'c2',
      tool: 'write_file',
      input: { path: '/Users/zach/proj/bar.ts' },
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'r2',
      callId: 'c2',
      output: '',
      durationMs: 1,
      truncated: false,
      stats: { path: '/Users/zach/proj/bar.ts', status: 'modified', additions: 1, deletions: 1 }
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    fireEvent.click(screen.getByText('bar.ts'))
    expect(openFile).not.toHaveBeenCalled()
    expect(openReviewForFile).toHaveBeenCalledWith('convo1', '/Users/zach/proj/bar.ts')
  })

  it('read_file step: Cmd-click on the file name calls openFile', () => {
    const openFile = vi.fn()
    useAppStore.setState({ openFile: openFile as never })

    const call: Event = {
      type: 'tool_call',
      id: 'c3',
      tool: 'read_file',
      input: { path: '/Users/zach/proj/baz.ts' },
      approvalState: 'approved'
    }

    render(<ToolStep call={call as never} convoId="convo1" />)

    const chip = screen.getByText('baz.ts')
    expect(chip.className).toContain('step-file')

    fireEvent.click(chip, { metaKey: true })
    expect(openFile).toHaveBeenCalledWith('/Users/zach/proj/baz.ts')
  })
})
