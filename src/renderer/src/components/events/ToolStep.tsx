import { useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconChevronRightSmall } from '../icons'
import './events.css'

type ToolCallEvent = Extract<Event, { type: 'tool_call' }>
type ToolResultEvent = Extract<Event, { type: 'tool_result' }>

interface ToolStepProps {
  call: ToolCallEvent
  result?: ToolResultEvent
  convoId: string
}

function inputStr(call: ToolCallEvent, key: string): string | null {
  const input = call.input
  if (typeof input === 'object' && input !== null && key in input) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

function summaryFor(call: ToolCallEvent, result?: ToolResultEvent): React.ReactNode {
  switch (call.tool) {
    case 'list_dir': {
      const path = inputStr(call, 'path')
      return (
        <span>
          Explored <b>{path && path !== '.' ? path : 'the workspace'}</b>
        </span>
      )
    }
    case 'read_file': {
      const path = inputStr(call, 'path') ?? inputStr(call, 'file_path')
      return (
        <span>
          Read <b>{path ? path.split('/').pop() : 'a file'}</b>
        </span>
      )
    }
    // Deep Agents' built-in search tools (orchestrator engine) mirror the
    // legacy list_dir/search_files intents; label them the same way instead
    // of falling through to the generic "Ran 1 command".
    case 'search_files':
    case 'glob':
    case 'grep': {
      const pattern = inputStr(call, 'pattern')
      return (
        <span>
          Searched for <b>{pattern ?? 'a pattern'}</b>
        </span>
      )
    }
    case 'ls': {
      const path = inputStr(call, 'path')
      return (
        <span>
          Explored <b>{path && path !== '.' ? path : 'the workspace'}</b>
        </span>
      )
    }
    case 'write_todos':
      return (
        <span>
          Updated the <b>plan</b>
        </span>
      )
    case 'task': {
      const desc = inputStr(call, 'description')
      return (
        <span>
          Delegated <b>{desc ?? 'a subtask'}</b>
        </span>
      )
    }
    case 'write_file':
    case 'edit_file': {
      // The path arrives under either 'path' or 'file_path' depending on the
      // model/tool variant; check both so the row shows the real filename.
      const path = inputStr(call, 'path') ?? inputStr(call, 'file_path')
      const name = path ? (path.split('/').pop() ?? path) : 'a file'
      const stats = result?.stats
      const verb =
        stats?.status === 'created' ? 'Created' : call.tool === 'write_file' ? 'Wrote' : 'Edited'
      return (
        <span>
          {result ? verb : 'Writing'} <b>{name}</b>
          {stats ? (
            <span className="step-stats">
              <span className="plus">+{stats.additions}</span>
              <span className="minus">-{stats.deletions}</span>
            </span>
          ) : null}
        </span>
      )
    }
    default:
      return (
        <span>
          Ran <b>1 command</b>
        </span>
      )
  }
}

export function ToolStep({ call, result, convoId }: ToolStepProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openReviewForFile = useAppStore((s) => s.openReviewForFile)

  // Write steps open the review pane at that file, like Antigravity.
  if ((call.tool === 'write_file' || call.tool === 'edit_file') && result?.stats) {
    const stats = result.stats
    return (
      <div className="step">
        <div className="step-row" onClick={() => openReviewForFile(convoId, stats.path)}>
          {summaryFor(call, result)}
          <span className="chev">
            <IconChevronRightSmall />
          </span>
        </div>
      </div>
    )
  }

  if (call.tool === 'run_command') {
    const command =
      typeof call.input === 'object' && call.input !== null && 'command' in call.input
        ? String((call.input as { command: unknown }).command)
        : ''
    if (call.approvalState === 'pending') {
      return <PendingCommand callId={call.id} command={command} convoId={convoId} />
    }
    const verb = call.approvalState === 'denied' ? 'Denied' : 'Ran'
    return (
      <div className={'step' + (open ? ' open' : '')}>
        <div className="step-row" onClick={() => setOpen((o) => !o)}>
          <span>{verb}</span>
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
    )
  }

  return (
    <div className={'step' + (open ? ' open' : '')}>
      <div className="step-row" onClick={() => setOpen((o) => !o)}>
        {summaryFor(call, result)}
        <span className="chev">
          <IconChevronRightSmall />
        </span>
      </div>
      <div className="step-body">{result ? result.output : 'Working…'}</div>
    </div>
  )
}

function PendingCommand({
  callId,
  command,
  convoId
}: {
  callId: string
  command: string
  convoId: string
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const addPermissionRule = useAppStore((s) => s.addPermissionRule)
  const projectPath = useAppStore((s) => s.conversations[convoId]?.projectPath ?? null)
  const [showAllow, setShowAllow] = useState(false)
  const prefix = command.trim().split(/\s+/)[0] + ' *'

  const allowOnce = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  // Number keys answer the prompt, matching the option badges.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '1') allowOnce()
      else if (e.key === '2') setShowAllow((s) => !s)
      else if (e.key === '3') deny()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId])

  return (
    <div className="step" id="pending-approval-card">
      <div className="step-row static">
        <span>
          Run <span className="mono">{command}</span>?
        </span>
      </div>
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">Allow running this command?</div>
        <div className="approval-cmd">{command}</div>
        <button className="approval-opt" onClick={allowOnce}>
          <span className="opt-num">1</span>
          Yes, allow this time
        </button>
        <button className="approval-opt" onClick={() => setShowAllow((s) => !s)}>
          <span className="opt-num">2</span>
          Yes, always allow
          <span className="opt-hint">save a rule instead of asking again</span>
        </button>
        {showAllow ? (
          <div className="allow-grid">
            <button
              className="allow-cell"
              onClick={() => {
                addPermissionRule({
                  scope: 'global',
                  action: 'command',
                  match: command,
                  effect: 'allow'
                })
                approveTool(callId, true)
              }}
            >
              This exact command, everywhere
            </button>
            <button
              className="allow-cell"
              onClick={() => {
                addPermissionRule({
                  scope: 'global',
                  action: 'command',
                  match: prefix,
                  effect: 'allow'
                })
                approveTool(callId, true)
              }}
            >
              Anything starting with <span className="mono">{prefix}</span>, everywhere
            </button>
            {projectPath ? (
              <>
                <button
                  className="allow-cell"
                  onClick={() => {
                    addPermissionRule({
                      scope: { projectPath },
                      action: 'command',
                      match: command,
                      effect: 'allow'
                    })
                    approveTool(callId, true)
                  }}
                >
                  This exact command, this project only
                </button>
                <button
                  className="allow-cell"
                  onClick={() => {
                    addPermissionRule({
                      scope: { projectPath },
                      action: 'command',
                      match: prefix,
                      effect: 'allow'
                    })
                    approveTool(callId, true)
                  }}
                >
                  Anything starting with <span className="mono">{prefix}</span>, this project only
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <button className="approval-opt" onClick={deny}>
          <span className="opt-num">3</span>
          No, deny it
          <span className="opt-hint">the agent is told you declined</span>
        </button>
      </div>
    </div>
  )
}
