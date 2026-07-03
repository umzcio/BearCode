import { useState } from 'react'
import type { Event } from '@shared/types'
import { IconChevronRightSmall } from '../icons'
import './events.css'

type ToolCallEvent = Extract<Event, { type: 'tool_call' }>
type ToolResultEvent = Extract<Event, { type: 'tool_result' }>

interface ToolStepProps {
  call: ToolCallEvent
  result?: ToolResultEvent
}

function summaryFor(call: ToolCallEvent): React.ReactNode {
  switch (call.tool) {
    case 'list_dir':
      return (
        <span>
          Explored <b>2 folders</b>
        </span>
      )
    case 'read_file':
      return (
        <span>
          Read <b>1 file</b>
        </span>
      )
    case 'search_files':
      return (
        <span>
          Searched <b>the workspace</b>
        </span>
      )
    default:
      return (
        <span>
          Ran <b>1 command</b>
        </span>
      )
  }
}

export function ToolStep({ call, result }: ToolStepProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  if (call.tool === 'run_command') {
    const command =
      typeof call.input === 'object' && call.input !== null && 'command' in call.input
        ? String((call.input as { command: unknown }).command)
        : ''
    return (
      <>
        <div className="step">
          <div className="step-row static">{summaryFor(call)}</div>
        </div>
        <div className={'step' + (open ? ' open' : '')}>
          <div className="step-row" onClick={() => setOpen((o) => !o)}>
            <span>Ran</span>
            <span className="mono">{command}</span>
            <span className="chev">
              <IconChevronRightSmall />
            </span>
          </div>
          <div className="step-body term">
            {result ? result.output : 'Running…'}
            {result && result.exitCode !== undefined ? (
              <>
                {'\n'}
                <span className="ok">exit code {result.exitCode}</span>
              </>
            ) : null}
          </div>
        </div>
      </>
    )
  }

  return (
    <div className={'step' + (open ? ' open' : '')}>
      <div className="step-row" onClick={() => setOpen((o) => !o)}>
        {summaryFor(call)}
        <span className="chev">
          <IconChevronRightSmall />
        </span>
      </div>
      <div className="step-body">{result ? result.output : 'Working…'}</div>
    </div>
  )
}
