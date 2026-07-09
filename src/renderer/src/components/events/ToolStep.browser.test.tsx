// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ToolStep } from './ToolStep'
import type { Event } from '@shared/types'

afterEach(cleanup)

describe('ToolStep browser_* step cards', () => {
  it('browser_navigate: renders the URL in the step row', () => {
    const call: Event = {
      type: 'tool_call',
      id: 'bc1',
      tool: 'browser_navigate',
      input: { url: 'https://example.com' },
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'br1',
      callId: 'bc1',
      output: 'Navigated to https://example.com/ — "Example Domain".',
      durationMs: 5,
      truncated: false
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    expect(screen.getAllByText(/https:\/\/example\.com/).length).toBeGreaterThan(0)
  })

  it('browser_screenshot: a data URL output renders as an <img>', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'
    const call: Event = {
      type: 'tool_call',
      id: 'bc2',
      tool: 'browser_screenshot',
      input: {},
      approvalState: 'approved'
    }
    const result: Event = {
      type: 'tool_result',
      id: 'br2',
      callId: 'bc2',
      output: dataUrl,
      durationMs: 5,
      truncated: false
    }

    render(<ToolStep call={call as never} result={result as never} convoId="convo1" />)

    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toBe(dataUrl)
    expect(img.className).toContain('browser-shot')
  })
})
