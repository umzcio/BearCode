import { useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconChevronRightSmall } from '../icons'
import './events.css'

type ToolCallEvent = Extract<Event, { type: 'tool_call' }>
type ToolResultEvent = Extract<Event, { type: 'tool_result' }>

// Read-side tools that the F8 outside-folder read gate ('ask' fileAccessPolicy)
// can pause for approval. A pending/denied state only ever occurs for a read
// whose path resolved OUTSIDE the project root; normal in-root reads never
// interrupt, so their tool_call has no approvalState and falls through.
const READ_TOOLS = new Set(['read_file', 'ls', 'grep', 'glob', 'list_dir', 'search_files'])

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

function summaryFor(
  call: ToolCallEvent,
  result: ToolResultEvent | undefined,
  openFile: (path: string) => void
): React.ReactNode {
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
      const name = path ? path.split('/').pop() : null
      return (
        <span>
          Read{' '}
          {path ? (
            <b
              className="step-file"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.stopPropagation()
                  openFile(path)
                }
              }}
            >
              {name}
            </b>
          ) : (
            <b>a file</b>
          )}
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
          {result ? verb : 'Writing'}{' '}
          {path ? (
            <b
              className="step-file"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.stopPropagation()
                  openFile(path)
                }
              }}
            >
              {name}
            </b>
          ) : (
            <b>{name}</b>
          )}
          {stats ? (
            <span className="step-stats">
              <span className="plus">+{stats.additions}</span>
              <span className="minus">-{stats.deletions}</span>
            </span>
          ) : null}
        </span>
      )
    }
    case 'submit_plan':
    case 'submit_walkthrough': {
      const title = inputStr(call, 'title')
      return (
        <span>
          Submitted {call.tool === 'submit_plan' ? 'plan' : 'walkthrough'}{' '}
          <b>{title ?? 'an artifact'}</b>
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

// Parallel approvals can put several pending cards on screen at once (any
// mix of run_command and write_file/edit_file); the number-key hotkeys and
// the jump-to-approval anchor id belong only to the FIRST pending tool_call
// in the conversation's event order, so one keypress never answers more than
// one card. Shared by PendingCommand and PendingEdit so both tool kinds
// participate in the same single-active-card scheme (ded9abc).
function useIsFirstPendingCard(convoId: string, callId: string): boolean {
  return useAppStore((s) => {
    const events = s.conversations[convoId]?.events
    if (!events) return false
    for (const e of events) {
      if (e.type === 'tool_call' && e.approvalState === 'pending') return e.id === callId
    }
    return false
  })
}

export function ToolStep({ call, result, convoId }: ToolStepProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openReviewForFile = useAppStore((s) => s.openReviewForFile)
  const openFile = useAppStore((s) => s.openFile)

  if (
    (call.tool === 'write_file' || call.tool === 'edit_file') &&
    call.approvalState === 'pending'
  ) {
    const path = inputStr(call, 'file_path') ?? inputStr(call, 'path') ?? 'a file'
    const requestedPath = inputStr(call, 'requested_path')
    return (
      <PendingEdit
        callId={call.id}
        path={path}
        requestedPath={requestedPath !== path ? requestedPath : null}
        verb={call.tool === 'write_file' ? 'write to' : 'edit'}
        convoId={convoId}
      />
    )
  }
  if (
    (call.tool === 'write_file' || call.tool === 'edit_file') &&
    call.approvalState === 'denied'
  ) {
    const path = inputStr(call, 'file_path') ?? inputStr(call, 'path') ?? 'a file'
    const requestedPath = inputStr(call, 'requested_path')
    const name = path.split('/').pop() ?? path
    return (
      <div className="step">
        <div className="step-row static">
          <span>
            Denied {call.tool === 'write_file' ? 'writing' : 'editing'} <b>{name}</b>
          </span>
        </div>
        {requestedPath && requestedPath !== path ? (
          <div className="waiting-note">
            requested as <span className="mono">{requestedPath}</span>
          </div>
        ) : null}
      </div>
    )
  }

  // F8: an outside-folder read awaiting approval ('ask' fileAccessPolicy). The
  // enriched input carries file_path = the jail-RESOLVED target (what the read
  // actually lands on) with the raw agent string as requested_path — shown so a
  // symlink that makes the path look in-project can't win a misinformed approval.
  if (READ_TOOLS.has(call.tool) && call.approvalState === 'pending') {
    const path = inputStr(call, 'file_path') ?? inputStr(call, 'path') ?? 'a path'
    const requestedPath = inputStr(call, 'requested_path')
    return (
      <PendingRead
        callId={call.id}
        path={path}
        requestedPath={requestedPath !== path ? requestedPath : null}
        convoId={convoId}
      />
    )
  }
  if (READ_TOOLS.has(call.tool) && call.approvalState === 'denied') {
    const path = inputStr(call, 'file_path') ?? inputStr(call, 'path') ?? 'a path'
    const name = path.split('/').pop() ?? path
    return (
      <div className="step">
        <div className="step-row static">
          <span>
            Denied reading <b>{name}</b>
          </span>
        </div>
      </div>
    )
  }

  // Write steps open the review pane at that file, like Antigravity.
  if ((call.tool === 'write_file' || call.tool === 'edit_file') && result?.stats) {
    const stats = result.stats
    return (
      <div className="step">
        <div className="step-row" onClick={() => openReviewForFile(convoId, stats.path)}>
          {summaryFor(call, result, openFile)}
          <span className="chev">
            <IconChevronRightSmall />
          </span>
        </div>
      </div>
    )
  }

  // Keyed on the enriched input's artifactId (Task 3), never on tool name
  // alone: a malformed submit_plan payload without the plan marker falls
  // through to the generic step rendering below rather than rendering
  // Proceed buttons wired to a dead channel (Task 3 review, binding).
  if (
    call.tool === 'submit_plan' &&
    call.approvalState === 'pending' &&
    inputStr(call, 'artifactId')
  ) {
    return (
      <PendingPlan
        callId={call.id}
        title={inputStr(call, 'title') ?? 'Implementation plan'}
        artifactId={inputStr(call, 'artifactId')}
        convoId={convoId}
      />
    )
  }
  if (
    call.tool === 'submit_plan' &&
    (call.approvalState === 'approved' || call.approvalState === 'denied') &&
    inputStr(call, 'artifactId')
  ) {
    // 'denied' here means "resolved without proceeding" (feedback sent, or the
    // run was stopped) -- never a permission denial; hence the plan-specific copy.
    const planTitle = inputStr(call, 'title') ?? 'the plan'
    return (
      <div className="step">
        <div className="step-row static">
          <span>
            {call.approvalState === 'approved' ? (
              <>
                Proceeding with plan <b>{planTitle}</b>
              </>
            ) : (
              <>
                Did not proceed with plan <b>{planTitle}</b>
              </>
            )}
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
        {summaryFor(call, result, openFile)}
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
  // Each answered card flips via its resolved event, making the next card the
  // first pending one -- the keys move down the stack naturally. An "always
  // allow" rule saved on one card never answers a sibling card: each still
  // needs its own click, and a sibling the user denies stays denied even
  // though the new rule would now allow its command -- the main process pins
  // denied decisions so the batch resume's rules re-evaluation cannot
  // override them (tools.ts deniedReplayPins).
  const isFirstPending = useIsFirstPendingCard(convoId, callId)
  const [showAllow, setShowAllow] = useState(false)
  const prefix = command.trim().split(/\s+/)[0] + ' *'

  const allowOnce = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  // Number keys answer the prompt, matching the option badges.
  useEffect(() => {
    if (!isFirstPending) return undefined
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
  }, [callId, isFirstPending])

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
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
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, allow this time
        </button>
        <button className="approval-opt" onClick={() => setShowAllow((s) => !s)}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
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
          {isFirstPending ? <span className="opt-num">3</span> : null}
          No, deny it
          <span className="opt-hint">the agent is told you declined</span>
        </button>
      </div>
    </div>
  )
}

// F8 outside-folder read approval card. Reads have no rule grammar (the engine
// gates reads only by the jail + fileAccessPolicy), so this is a plain
// allow-once / deny card reusing the generic approveTool resume flow.
function PendingRead({
  callId,
  path,
  requestedPath,
  convoId
}: {
  callId: string
  path: string
  requestedPath: string | null
  convoId: string
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const isFirstPending = useIsFirstPendingCard(convoId, callId)

  const allow = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  useEffect(() => {
    if (!isFirstPending) return undefined
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '1') allow()
      else if (e.key === '2') deny()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, isFirstPending])

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Allow the agent to read <span className="mono">{path}</span> outside the project folder?
        </span>
      </div>
      {requestedPath ? (
        <div className="waiting-note">
          requested as <span className="mono">{requestedPath}</span>
        </div>
      ) : null}
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">This path is outside the project folder.</div>
        <div className="approval-cmd">{path}</div>
        <button className="approval-opt" onClick={allow}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, allow this read
        </button>
        <button className="approval-opt" onClick={deny}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          No, deny it
          <span className="opt-hint">the agent is told you declined</span>
        </button>
      </div>
    </div>
  )
}

function PendingEdit({
  callId,
  path,
  requestedPath,
  verb,
  convoId
}: {
  callId: string
  path: string
  requestedPath: string | null
  verb: string
  convoId: string
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const isFirstPending = useIsFirstPendingCard(convoId, callId)

  const allow = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  // Number keys answer the prompt, matching the option badges. Rule
  // authoring for edits (the "always allow" panel) arrives with the Bb4
  // manager UI, so this card only ever has two options: allow once or deny.
  useEffect(() => {
    if (!isFirstPending) return undefined
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '1') allow()
      else if (e.key === '2') deny()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, isFirstPending])

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Allow the agent to {verb} <span className="mono">{path}</span>?
        </span>
      </div>
      {requestedPath ? (
        <div className="waiting-note">
          requested as <span className="mono">{requestedPath}</span>
        </div>
      ) : null}
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">A permission rule asks before this edit.</div>
        <div className="approval-cmd">{path}</div>
        <button className="approval-opt" onClick={allow}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, apply this edit
        </button>
        <button className="approval-opt" onClick={deny}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          No, deny it
          <span className="opt-hint">the agent is told you declined</span>
        </button>
      </div>
    </div>
  )
}

// The plan-review pending card (design 3.5): the third pending-card kind,
// sharing useIsFirstPendingCard's single-active-card hotkey scheme with
// PendingCommand/PendingEdit. Proceed resumes { proceed: true } over the
// artifacts channel -- it never touches tools.approve and NEVER pre-approves
// any command or edit (the Bb gates still run per call during implementation).
function PendingPlan({
  callId,
  title,
  artifactId,
  convoId
}: {
  callId: string
  title: string
  artifactId: string | null
  convoId: string
}): React.JSX.Element {
  const resolvePlanReview = useAppStore((s) => s.resolvePlanReview)
  const openArtifactPane = useAppStore((s) => s.openArtifactPane)
  const isFirstPending = useIsFirstPendingCard(convoId, callId)

  const proceed = (): void => void resolvePlanReview(callId, true)
  const openPane = (): void => {
    if (artifactId) openArtifactPane(artifactId)
  }
  const sendFeedback = (): void => {
    if (artifactId) openArtifactPane(artifactId, true)
  }

  useEffect(() => {
    if (!isFirstPending) return undefined
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '1') proceed()
      else if (e.key === '2') openPane()
      else if (e.key === '3') sendFeedback()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, isFirstPending, artifactId])

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Plan ready for review: <b>{title}</b>
        </span>
      </div>
      <div className="waiting-note">Waiting for your review…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">
          Review the implementation plan before the agent proceeds.
        </div>
        <button className="approval-opt" onClick={proceed}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Proceed
          <span className="opt-hint">approve the plan and begin implementation</span>
        </button>
        <button className="approval-opt" onClick={openPane} disabled={!artifactId}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          Open in pane
          <span className="opt-hint">read the full plan and add comments</span>
        </button>
        <button className="approval-opt" onClick={sendFeedback} disabled={!artifactId}>
          {isFirstPending ? <span className="opt-num">3</span> : null}
          Send feedback
          <span className="opt-hint">opens the plan with the comment box focused</span>
        </button>
      </div>
    </div>
  )
}
