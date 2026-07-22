// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ReviewFindings } from './ReviewFindings'
import type { Event } from '@shared/types'

afterEach(cleanup)

function findingEvent(
  id: string,
  severity: 'critical' | 'important' | 'minor',
  title: string,
  file = 'src/foo.ts',
  line: number | undefined = 12
): Event {
  return {
    type: 'review_finding',
    id,
    finding: {
      severity,
      lens: 'security',
      file,
      line,
      title,
      detail: `detail for ${title}`
    },
    createdAt: 1
  } as unknown as Event
}

describe('ReviewFindings', () => {
  it('renders nothing when there are no findings and no summary', () => {
    const { container } = render(<ReviewFindings events={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders each finding's title, severity, and file:line, critical before minor", () => {
    const events = [
      findingEvent('f1', 'minor', 'Missing alt text', 'src/img.tsx', 40),
      findingEvent('f2', 'critical', 'SQL injection', 'src/db.ts', 12),
      findingEvent('f3', 'important', 'Unbounded loop', 'src/loop.ts', 7)
    ] as never
    render(<ReviewFindings events={events} />)

    expect(screen.getByText('SQL injection')).toBeTruthy()
    expect(screen.getByText('Unbounded loop')).toBeTruthy()
    expect(screen.getByText('Missing alt text')).toBeTruthy()
    expect(screen.getByText('Critical')).toBeTruthy()
    expect(screen.getByText('Important')).toBeTruthy()
    expect(screen.getByText('Minor')).toBeTruthy()
    expect(screen.getByText('src/db.ts:12')).toBeTruthy()

    // Critical-first ordering: the row for the critical finding appears
    // before the row for the minor finding in document order.
    const critTitle = screen.getByText('SQL injection')
    const minorTitle = screen.getByText('Missing alt text')
    expect(
      critTitle.compareDocumentPosition(minorTitle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('renders the summary counts and note when a review_summary is present', () => {
    const summary = {
      type: 'review_summary',
      id: 's1',
      counts: { critical: 1, important: 2, minor: 0 },
      byLens: { security: 3 },
      note: 'Scoped to src/',
      createdAt: 2
    } as unknown as Event
    render(<ReviewFindings events={[]} summary={summary as never} />)
    expect(screen.getByText('Scoped to src/')).toBeTruthy()
    expect(screen.getByText('1 critical')).toBeTruthy()
    expect(screen.getByText('2 important')).toBeTruthy()
    expect(screen.getByText('0 minor')).toBeTruthy()
  })

  it('clicking a finding opens the file in the aux pane at its exact line', () => {
    const openFileInPane = vi.fn()
    useAppStore.setState({ openFileInPane: openFileInPane as never })
    const events = [findingEvent('f1', 'critical', 'SQL injection', 'src/db.ts', 12)] as never
    render(<ReviewFindings events={events} />)

    fireEvent.click(screen.getByText('SQL injection'))
    expect(openFileInPane).toHaveBeenCalledWith('src/db.ts', 12)
  })

  it('clicking a finding with no line opens the file without a line', () => {
    const openFileInPane = vi.fn()
    useAppStore.setState({ openFileInPane: openFileInPane as never })
    const events = [
      {
        type: 'review_finding',
        id: 'f1',
        finding: {
          severity: 'important',
          lens: 'security',
          file: 'src/big.ts',
          title: 'Whole-file smell',
          detail: 'no single line'
        },
        createdAt: 1
      }
    ] as never
    render(<ReviewFindings events={events} />)

    fireEvent.click(screen.getByText('Whole-file smell'))
    expect(openFileInPane).toHaveBeenCalledWith('src/big.ts', undefined)
  })
})
