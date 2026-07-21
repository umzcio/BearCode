import { createContext, useContext, useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore, modelDisplay } from '../../state/store'
import { IconChevronRightSmall } from '../icons'
import { Select } from '../Select'
import { usePendingCardHotkeys } from './usePendingCardHotkeys'
import { AllowGrid } from './AllowGrid'
import ursaTeddy from '../../assets/ursa-teddy.svg'
import ursusTeddy from '../../assets/ursus-teddy.svg'
import { URSUS_MODEL_REF } from '@shared/types'
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

// mcp__<server>__<tool> (Claude Code convention, tools.ts buildMcpTools) split
// back into its parts for display; a malformed/short name falls back to the
// raw tool string rather than throwing.
function mcpParts(tool: string): { server: string; toolName: string } | null {
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep < 0) return null
  return { server: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
}

// Pretty-print an MCP tool call's arguments for the approval card so consent is
// never granted blind (finding 3). Empty/absent args render as null (the card
// then shows just the tool name); a non-serializable value falls back to String
// so rendering can never throw.
function mcpArgsText(input: unknown): string | null {
  if (input == null) return null
  if (typeof input === 'object' && Object.keys(input as object).length === 0) return null
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

// Ursa Phase 2: the synthetic `ursa_pipeline` consent card's input carries
// `{ steps: Array<{ role, modelRef, subtask }> }`. Parse defensively -- a
// malformed/absent payload yields [] so the card degrades to an empty (but
// non-throwing) proposal rather than crashing the transcript on replay.
interface PipelineStep {
  role: string
  modelRef: string
  subtask: string
}
function pipelineSteps(input: unknown): PipelineStep[] {
  if (typeof input !== 'object' || input === null) return []
  const raw = (input as { steps?: unknown }).steps
  if (!Array.isArray(raw)) return []
  const out: PipelineStep[] = []
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue
    const step = s as Record<string, unknown>
    out.push({
      role: typeof step.role === 'string' ? step.role : '',
      modelRef: typeof step.modelRef === 'string' ? step.modelRef : '',
      subtask: typeof step.subtask === 'string' ? step.subtask : ''
    })
  }
  return out
}

function summaryFor(
  call: ToolCallEvent,
  result: ToolResultEvent | undefined,
  openFile: (path: string) => void
): React.ReactNode {
  if (call.tool.startsWith('mcp__')) {
    const parts = mcpParts(call.tool)
    return <span>{parts ? `${parts.server} · ${parts.toolName}` : call.tool}</span>
  }
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

// Human-readable action label for a browser_* tool_call, matching the
// `action` strings the main-side gate passes to interrupt() (tools.ts
// gateBrowserAction call sites: "navigate <url>", "click <ref>", etc.) so the
// approval card and the resolved step row read the same phrase.
function browserActionLabel(call: ToolCallEvent): string {
  switch (call.tool) {
    case 'browser_navigate':
      return `navigate ${inputStr(call, 'url') ?? ''}`.trim()
    case 'browser_read':
      return `read page (${inputStr(call, 'mode') ?? 'a11y'})`
    case 'browser_screenshot':
      return 'screenshot'
    case 'browser_scroll':
      return `scroll ${inputStr(call, 'direction') ?? 'down'}`
    case 'browser_wait':
      return `wait for ${inputStr(call, 'state') ?? 'load'}`
    case 'browser_click':
      return `click ${inputStr(call, 'ref') ?? ''}`.trim()
    case 'browser_type':
      return `type into ${inputStr(call, 'ref') ?? ''}`.trim()
    case 'browser_evaluate':
      return 'evaluate JavaScript in the page'
    default:
      return call.tool
  }
}

// ConversationView renders the FIRST pending approval's ToolStep a second
// time, pinned directly above the composer, wrapped in this provider -- so
// the user never has to scroll up to find the card. The pinned copy is THE
// interactive card: hotkeys, the 1/2/3 number chips, and the anchor id all
// live there (useFirstPendingCallId below returns null OUTSIDE it), while
// the transcript's inline copy keeps only the passive record -- its
// .approval-card is hidden by CSS (`.convo-scroll .approval-card`,
// ConversationView.css), leaving the step row + waiting note in place.
// Clicks on either copy would be safe regardless: graph.ts's
// resolveInterrupt no-ops a second resolve for an answered callId.
export const PinnedApprovalArea = createContext(false)

// Parallel approvals can put several pending cards on screen at once (any
// mix of run_command and write_file/edit_file); the number-key hotkeys and
// the jump-to-approval anchor id belong only to the FIRST pending tool_call
// in the conversation's event order, so one keypress never answers more than
// one card -- and only the pinned copy above the composer is interactive
// (see PinnedApprovalArea above), so the singletons can never double up.
// Computed ONCE per ToolStep render (instead of once per Pending* card,
// M-17) and passed down as an `isFirst` prop to whichever card is rendered.
function useFirstPendingCallId(convoId: string): string | null {
  const pinnedCopy = useContext(PinnedApprovalArea)
  return useAppStore((s) => {
    if (!pinnedCopy) return null
    const events = s.conversations[convoId]?.events
    if (!events) return null
    for (const e of events) {
      if (e.type === 'tool_call' && e.approvalState === 'pending') return e.id
    }
    return null
  })
}

export function ToolStep({ call, result, convoId }: ToolStepProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openReviewForFile = useAppStore((s) => s.openReviewForFile)
  const openFile = useAppStore((s) => s.openFile)
  const firstPendingCallId = useFirstPendingCallId(convoId)
  const isFirst = call.id === firstPendingCallId

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
        isFirst={isFirst}
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
        isFirst={isFirst}
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
        isFirst={isFirst}
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

  // G-skills Task 8: /learn's propose_skill card. Selected by tool + pending
  // state alone (the payload is always well-formed input from tools.ts), not
  // by a marker field -- there is no artifactId analog to guard on here.
  if (call.tool === 'propose_skill' && call.approvalState === 'pending') {
    return <PendingSkillProposal callId={call.id} input={call.input} />
  }
  if (
    call.tool === 'propose_skill' &&
    (call.approvalState === 'approved' || call.approvalState === 'denied')
  ) {
    const name = inputStr(call, 'name') ?? 'a skill'
    return (
      <div className="step">
        <div className="step-row static">
          <span>
            {call.approvalState === 'approved' ? (
              <>
                Saved skill <b>{name}</b>
              </>
            ) : (
              <>
                Discarded proposed skill <b>{name}</b>
              </>
            )}
          </span>
        </div>
      </div>
    )
  }

  // Ursa Phase 2: the pre-graph pipeline proposal card. Unlike every other
  // pending card here it resolves through window.bearcode.ursa.resolvePipeline
  // (NOT tools.approve) -- the pause is pre-graph and never enters graph.ts's
  // pendingApprovals map. It still lives in the shared pinned-approval area and
  // uses the same first-pending hotkey machinery as the rest.
  if (call.tool === 'ursa_pipeline') {
    if (call.approvalState === 'pending') {
      return (
        <PendingPipeline
          callId={call.id}
          convoId={convoId}
          steps={pipelineSteps(call.input)}
          isFirst={isFirst}
        />
      )
    }
    if (call.approvalState === 'approved' || call.approvalState === 'denied') {
      return (
        <div className="step">
          <div className="step-row static">
            <span>{call.approvalState === 'approved' ? 'Pipeline approved' : 'Pipeline declined'}</span>
          </div>
        </div>
      )
    }
  }

  // F4: browser_* tools. Mutations (click/type/evaluate) can interrupt for
  // approval exactly like run_command; reads/navigate never do. Modeled on
  // the run_command body just above/below, but the action label varies per
  // tool and a screenshot result renders as an <img> instead of text.
  if (call.tool.startsWith('browser_')) {
    const action = browserActionLabel(call)
    if (call.approvalState === 'pending') {
      return <PendingBrowserAction callId={call.id} action={action} isFirst={isFirst} />
    }
    if (call.approvalState === 'denied') {
      return (
        <div className="step">
          <div className="step-row static">
            <span>
              Denied <span className="mono">{action}</span>
            </span>
          </div>
        </div>
      )
    }
    const output = result?.output
    const isScreenshot = typeof output === 'string' && output.startsWith('data:image/')
    return (
      <div className={'step' + (open ? ' open' : '')}>
        <div className="step-row" onClick={() => setOpen((o) => !o)}>
          <span>{result ? 'Ran' : 'Running'}</span>
          <span className="mono">{action}</span>
          <span className="chev">
            <IconChevronRightSmall />
          </span>
        </div>
        <div className="step-body">
          {isScreenshot ? (
            <img className="browser-shot" src={output} alt="Browser screenshot" />
          ) : (
            (output ?? 'Working…')
          )}
        </div>
      </div>
    )
  }

  // Integrations tool calls (github_*/bitbucket_*, Task 9/10 buildIntegrationTools).
  // Same uniform-gate shape as MCP: every call can pause for approval via the
  // 'integration' permission action. PendingIntegrationAction mirrors
  // PendingMcpAction (args shown, "always allow this provider" allow-grid
  // cell saving an `integration` rule matching `<provider>.*`).
  if (call.tool.startsWith('github_') || call.tool.startsWith('bitbucket_')) {
    const provider: 'github' | 'bitbucket' = call.tool.startsWith('github_')
      ? 'github'
      : 'bitbucket'
    const toolName = call.tool.slice(provider.length + 1)
    if (call.approvalState === 'pending') {
      return (
        <PendingIntegrationAction
          callId={call.id}
          provider={provider}
          toolName={toolName}
          input={call.input}
          convoId={convoId}
          isFirst={isFirst}
        />
      )
    }
    if (call.approvalState === 'denied') {
      return (
        <div className="step">
          <div className="step-row static">
            <span>
              Denied{' '}
              <span className="mono">
                {provider} · {toolName}
              </span>
            </span>
          </div>
        </div>
      )
    }
    return (
      <div className={'step' + (open ? ' open' : '')}>
        <div className="step-row" onClick={() => setOpen((o) => !o)}>
          <span>
            {provider} · {toolName}
          </span>
          <span className="chev">
            <IconChevronRightSmall />
          </span>
        </div>
        <div className="step-body">{result ? result.output : 'Working…'}</div>
      </div>
    )
  }

  // MCP tool calls (mcp__<server>__<tool>, Task 6 buildMcpTools). Uniform-gate
  // means every call can pause for approval, mirroring PendingBrowserAction;
  // resolved calls render as a plain expandable step like the generic case.
  if (call.tool.startsWith('mcp__')) {
    const parts = mcpParts(call.tool)
    const server = parts?.server ?? 'mcp'
    const toolName = parts?.toolName ?? call.tool
    if (call.approvalState === 'pending') {
      return (
        <PendingMcpAction
          callId={call.id}
          server={server}
          toolName={toolName}
          input={call.input}
          convoId={convoId}
          isFirst={isFirst}
        />
      )
    }
    if (call.approvalState === 'denied') {
      return (
        <div className="step">
          <div className="step-row static">
            <span>
              Denied{' '}
              <span className="mono">
                {server} · {toolName}
              </span>
            </span>
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

  if (call.tool === 'run_command') {
    const command =
      typeof call.input === 'object' && call.input !== null && 'command' in call.input
        ? String((call.input as { command: unknown }).command)
        : ''
    const isUnsandboxed =
      typeof call.input === 'object' &&
      call.input !== null &&
      (call.input as { unsandboxed?: unknown }).unsandboxed === true
    if (call.approvalState === 'pending') {
      return isUnsandboxed ? (
        <PendingUnsandboxed
          callId={call.id}
          command={command}
          convoId={convoId}
          isFirst={isFirst}
        />
      ) : (
        <PendingCommand callId={call.id} command={command} convoId={convoId} isFirst={isFirst} />
      )
    }
    const verb = call.approvalState === 'denied' ? 'Denied' : 'Ran'
    const sandboxed = result?.sandboxed === true
    // exitCode rides the first output line ("exit code N"); parse best-effort.
    const exitLine = result?.output?.match(/^exit code (-?\d+)/)
    const nonZero = exitLine ? Number(exitLine[1]) !== 0 : false
    return (
      <div className={'step' + (open ? ' open' : '')}>
        <div className="step-row" onClick={() => setOpen((o) => !o)}>
          <span>{verb}</span>
          <span className="mono">{command}</span>
          {sandboxed ? (
            <span className="sandbox-badge" title="Ran inside the sandbox">
              sandboxed
            </span>
          ) : null}
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
          {sandboxed && nonZero ? (
            <div className="sandbox-hint" role="note">
              This command may have been blocked by the sandbox. Ask the agent to re-run it outside
              the sandbox to check.
            </div>
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
  convoId,
  isFirst
}: {
  callId: string
  command: string
  convoId: string
  isFirst: boolean
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
  const isFirstPending = isFirst
  const [showAllow, setShowAllow] = useState(false)
  const prefix = command.trim().split(/\s+/)[0] + ' *'

  const allowOnce = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)
  const toggleAllow = (): void => setShowAllow((s) => !s)

  usePendingCardHotkeys({
    active: isFirstPending,
    onApprove: allowOnce,
    onDeny: deny,
    onAlways: toggleAllow
  })

  const allowCells = [
    {
      key: 'exact-global',
      label: 'This exact command, everywhere',
      onClick: (): void => {
        addPermissionRule({ scope: 'global', action: 'command', match: command, effect: 'allow' })
        approveTool(callId, true)
      }
    },
    {
      key: 'prefix-global',
      label: (
        <>
          Anything starting with <span className="mono">{prefix}</span>, everywhere
        </>
      ),
      onClick: (): void => {
        addPermissionRule({ scope: 'global', action: 'command', match: prefix, effect: 'allow' })
        approveTool(callId, true)
      }
    },
    ...(projectPath
      ? [
          {
            key: 'exact-project',
            label: 'This exact command, this project only',
            onClick: (): void => {
              addPermissionRule({
                scope: { projectPath },
                action: 'command',
                match: command,
                effect: 'allow'
              })
              approveTool(callId, true)
            }
          },
          {
            key: 'prefix-project',
            label: (
              <>
                Anything starting with <span className="mono">{prefix}</span>, this project only
              </>
            ),
            onClick: (): void => {
              addPermissionRule({
                scope: { projectPath },
                action: 'command',
                match: prefix,
                effect: 'allow'
              })
              approveTool(callId, true)
            }
          }
        ]
      : [])
  ]

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
        <button className="approval-opt" onClick={toggleAllow}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          Yes, always allow
          <span className="opt-hint">save a rule instead of asking again</span>
        </button>
        {showAllow ? <AllowGrid cells={allowCells} /> : null}
        <button className="approval-opt" onClick={deny}>
          {isFirstPending ? <span className="opt-num">3</span> : null}
          No, deny it
          <span className="opt-hint">the agent is told you declined</span>
        </button>
      </div>
    </div>
  )
}

// Task 7: the "run outside the sandbox?" card for a run_command call whose
// pending input carries `unsandboxed: true` (synthesizedApprovalCard /
// tools.ts's Seatbelt gate). Modeled on PendingCommand -- same hotkeys,
// allow-grid shape, and generic approveTool resume -- but the copy reflects
// the opposite direction: Approved (1/allow-rule) runs the command RAW
// outside the sandbox; Denied (3) keeps it running inside the sandbox rather
// than blocking it outright.
function PendingUnsandboxed({
  callId,
  command,
  convoId,
  isFirst
}: {
  callId: string
  command: string
  convoId: string
  isFirst: boolean
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const addPermissionRule = useAppStore((s) => s.addPermissionRule)
  const projectPath = useAppStore((s) => s.conversations[convoId]?.projectPath ?? null)
  const isFirstPending = isFirst
  const [showAllow, setShowAllow] = useState(false)
  const prefix = command.trim().split(/\s+/)[0] + ' *'

  const allowOnce = (): void => approveTool(callId, true) // approved => run RAW (outside the box)
  const keepSandboxed = (): void => approveTool(callId, false) // denied => run wrapped
  const toggleAllow = (): void => setShowAllow((s) => !s)

  usePendingCardHotkeys({
    active: isFirstPending,
    onApprove: allowOnce,
    onDeny: keepSandboxed,
    onAlways: toggleAllow
  })

  const allowRule = (scope: 'global' | { projectPath: string }, match: string): void => {
    addPermissionRule({ scope, action: 'unsandboxed', match, effect: 'allow' })
    approveTool(callId, true)
  }

  const allowCells = [
    {
      key: 'exact-global',
      label: 'This exact command, everywhere',
      onClick: (): void => allowRule('global', command)
    },
    {
      key: 'prefix-global',
      label: (
        <>
          Anything starting with <span className="mono">{prefix}</span>, everywhere
        </>
      ),
      onClick: (): void => allowRule('global', prefix)
    },
    ...(projectPath
      ? [
          {
            key: 'exact-project',
            label: 'This exact command, this project only',
            onClick: (): void => allowRule({ projectPath }, command)
          },
          {
            key: 'prefix-project',
            label: (
              <>
                Anything starting with <span className="mono">{prefix}</span>, this project only
              </>
            ),
            onClick: (): void => allowRule({ projectPath }, prefix)
          }
        ]
      : [])
  ]

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Run <span className="mono">{command}</span> outside the sandbox?
        </span>
      </div>
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">Run this command outside the sandbox?</div>
        <div className="approval-cmd">{command}</div>
        <button className="approval-opt" onClick={allowOnce}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, run it unsandboxed this time
        </button>
        <button className="approval-opt" onClick={toggleAllow}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          Yes, always run unsandboxed
          <span className="opt-hint">save an unsandboxed rule instead of asking again</span>
        </button>
        {showAllow ? <AllowGrid cells={allowCells} /> : null}
        <button className="approval-opt" onClick={keepSandboxed}>
          {isFirstPending ? <span className="opt-num">3</span> : null}
          No, keep it sandboxed
          <span className="opt-hint">the command still runs, inside the sandbox</span>
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
  isFirst
}: {
  callId: string
  path: string
  requestedPath: string | null
  isFirst: boolean
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const isFirstPending = isFirst

  const allow = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  usePendingCardHotkeys({ active: isFirstPending, onApprove: allow, onDeny: deny })

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

// F4 browser mutation approval card ('ask' mode) or the folded session-consent
// prompt (the first browser action in a conversation). Browser actions have
// no rule grammar like run_command's "always allow this command" panel, so
// this stays a plain allow-once / deny card, matching PendingRead's shape.
function PendingBrowserAction({
  callId,
  action,
  isFirst
}: {
  callId: string
  action: string
  isFirst: boolean
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const isFirstPending = isFirst

  const allow = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  usePendingCardHotkeys({ active: isFirstPending, onApprove: allow, onDeny: deny })

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Allow the agent to <span className="mono">{action}</span>?
        </span>
      </div>
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">Allow this browser action?</div>
        <div className="approval-cmd">{action}</div>
        <button className="approval-opt" onClick={allow}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, allow this time
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

// MCP tool call approval card ('mcp' action is uniform-gate: Ask by default
// for every tool, no auto read/write trust). Modeled on PendingBrowserAction,
// plus an "always allow this server" allow-grid cell (copied from
// PendingCommand's allow-grid) that saves an `mcp` rule matching
// `<server>.*` so future calls to any tool on this server skip the prompt.
function PendingMcpAction({
  callId,
  server,
  toolName,
  input,
  convoId,
  isFirst
}: {
  callId: string
  server: string
  toolName: string
  input: unknown
  convoId: string
  isFirst: boolean
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const addPermissionRule = useAppStore((s) => s.addPermissionRule)
  const projectPath = useAppStore((s) => s.conversations[convoId]?.projectPath ?? null)
  const isFirstPending = isFirst
  const [showAllow, setShowAllow] = useState(false)
  const label = `${server} · ${toolName}`
  // Render the call ARGUMENTS, not just the tool name: an "Ask" consent granted
  // without seeing the target/content is granted blind (e.g. fs · write_file to
  // /etc/hosts, or github · create_issue on attacker/x). run_command shows the
  // full command and edit_file shows the path; the MCP card must show its args
  // too or the uniform-gate Ask is defeated (G3 whole-branch review, finding 3).
  const argsText = mcpArgsText(input)

  const allowOnce = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)
  const toggleAllow = (): void => setShowAllow((s) => !s)

  usePendingCardHotkeys({
    active: isFirstPending,
    onApprove: allowOnce,
    onDeny: deny,
    onAlways: toggleAllow
  })

  const allowCells = [
    {
      key: 'server-global',
      label: (
        <>
          Any tool on <span className="mono">{server}</span>, everywhere
        </>
      ),
      onClick: (): void => {
        addPermissionRule({ scope: 'global', action: 'mcp', match: `${server}.*`, effect: 'allow' })
        approveTool(callId, true)
      }
    },
    ...(projectPath
      ? [
          {
            key: 'server-project',
            label: (
              <>
                Any tool on <span className="mono">{server}</span>, this project only
              </>
            ),
            onClick: (): void => {
              addPermissionRule({
                scope: { projectPath },
                action: 'mcp',
                match: `${server}.*`,
                effect: 'allow'
              })
              approveTool(callId, true)
            }
          }
        ]
      : [])
  ]

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Allow this MCP tool call? <span className="mono">{label}</span>
        </span>
      </div>
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">Allow this MCP tool call?</div>
        <div className="approval-cmd">{label}</div>
        {argsText ? <pre className="approval-args">{argsText}</pre> : null}
        <button className="approval-opt" onClick={allowOnce}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, allow this time
        </button>
        <button className="approval-opt" onClick={toggleAllow}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          Yes, always allow
          <span className="opt-hint">save a rule instead of asking again</span>
        </button>
        {showAllow ? <AllowGrid cells={allowCells} /> : null}
        <button className="approval-opt" onClick={deny}>
          {isFirstPending ? <span className="opt-num">3</span> : null}
          No, deny it
          <span className="opt-hint">the agent is told you declined</span>
        </button>
      </div>
    </div>
  )
}

// Integration tool call approval card ('integration' action is uniform-gate:
// Ask by default for every github_*/bitbucket_* tool, same posture as MCP).
// Copied from PendingMcpAction's shape (args shown, allow-grid saving a
// `<provider>.*` rule) since the design calls for reusing that shape wholesale.
function PendingIntegrationAction({
  callId,
  provider,
  toolName,
  input,
  convoId,
  isFirst
}: {
  callId: string
  provider: 'github' | 'bitbucket'
  toolName: string
  input: unknown
  convoId: string
  isFirst: boolean
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const addPermissionRule = useAppStore((s) => s.addPermissionRule)
  const projectPath = useAppStore((s) => s.conversations[convoId]?.projectPath ?? null)
  const isFirstPending = isFirst
  const [showAllow, setShowAllow] = useState(false)
  const providerLabel = provider === 'github' ? 'GitHub' : 'Bitbucket'
  const label = `${providerLabel} · ${toolName}`
  // Render the call ARGUMENTS, not just the tool name -- an "Ask" consent
  // granted without seeing the target (e.g. github · create_pr onto main) is
  // granted blind, same rationale as PendingMcpAction's argsText.
  const argsText = mcpArgsText(input)

  const allowOnce = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)
  const toggleAllow = (): void => setShowAllow((s) => !s)

  usePendingCardHotkeys({
    active: isFirstPending,
    onApprove: allowOnce,
    onDeny: deny,
    onAlways: toggleAllow
  })

  const allowCells = [
    {
      key: 'provider-global',
      label: `Any ${providerLabel} tool, everywhere`,
      onClick: (): void => {
        addPermissionRule({
          scope: 'global',
          action: 'integration',
          match: `${provider}.*`,
          effect: 'allow'
        })
        approveTool(callId, true)
      }
    },
    ...(projectPath
      ? [
          {
            key: 'provider-project',
            label: `Any ${providerLabel} tool, this project only`,
            onClick: (): void => {
              addPermissionRule({
                scope: { projectPath },
                action: 'integration',
                match: `${provider}.*`,
                effect: 'allow'
              })
              approveTool(callId, true)
            }
          }
        ]
      : [])
  ]

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>
          Allow this {providerLabel} tool call? <span className="mono">{label}</span>
        </span>
      </div>
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once">
        <div className="approval-title">Allow this {providerLabel} tool call?</div>
        <div className="approval-cmd">{label}</div>
        {argsText ? <pre className="approval-args">{argsText}</pre> : null}
        <button className="approval-opt" onClick={allowOnce}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, allow this time
        </button>
        <button className="approval-opt" onClick={toggleAllow}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          Yes, always allow
          <span className="opt-hint">save a rule instead of asking again</span>
        </button>
        {showAllow ? <AllowGrid cells={allowCells} /> : null}
        <button className="approval-opt" onClick={deny}>
          {isFirstPending ? <span className="opt-num">3</span> : null}
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
  isFirst
}: {
  callId: string
  path: string
  requestedPath: string | null
  verb: string
  isFirst: boolean
}): React.JSX.Element {
  const approveTool = useAppStore((s) => s.approveTool)
  const isFirstPending = isFirst

  const allow = (): void => approveTool(callId, true)
  const deny = (): void => approveTool(callId, false)

  // Rule authoring for edits (the "always allow" panel) arrives with the Bb4
  // manager UI, so this card only ever has two options: allow once or deny.
  usePendingCardHotkeys({ active: isFirstPending, onApprove: allow, onDeny: deny })

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
// sharing the single-active-card hotkey scheme (first-pending selector) with
// PendingCommand/PendingEdit. Proceed resumes { proceed: true } over the
// artifacts channel -- it never touches tools.approve and NEVER pre-approves
// any command or edit (the Bb gates still run per call during implementation).
function PendingPlan({
  callId,
  title,
  artifactId,
  isFirst
}: {
  callId: string
  title: string
  artifactId: string | null
  isFirst: boolean
}): React.JSX.Element {
  const resolvePlanReview = useAppStore((s) => s.resolvePlanReview)
  const openArtifactPane = useAppStore((s) => s.openArtifactPane)
  const isFirstPending = isFirst

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

// Ursa Phase 2: the pipeline proposal card. Shows the full plan -- teddy +
// "Ursa proposes a pipeline" + one numbered row per step (role chip + model +
// subtask) -- so the user sees exactly what will run before any model does.
// Resolves through resolvePipeline (window.bearcode.ursa.resolvePipeline), a
// plain allow/deny like PendingRead: Approve runs the steps in order, Deny runs
// the turn single-role (never an error). Reuses the shared first-pending hotkey
// machinery (1 = approve, 2 = deny) and the pinned-approval-card anchor id.
function PendingPipeline({
  callId,
  convoId,
  steps,
  isFirst
}: {
  callId: string
  convoId: string
  steps: PipelineStep[]
  isFirst: boolean
}): React.JSX.Element {
  const resolvePipeline = useAppStore((s) => s.resolvePipeline)
  const providers = useAppStore((s) => s.providers)
  const isFirstPending = isFirst
  const isUrsusTurn = useAppStore((s) => s.modelRef) === URSUS_MODEL_REF
  const routerLabel = isUrsusTurn ? 'Ursus' : 'Ursa'
  const routerIcon = isUrsusTurn ? ursusTeddy : ursaTeddy

  const approve = (): void => resolvePipeline(convoId, callId, true)
  const deny = (): void => resolvePipeline(convoId, callId, false)

  usePendingCardHotkeys({ active: isFirstPending, onApprove: approve, onDeny: deny })

  return (
    <div className="step" id={isFirstPending ? 'pending-approval-card' : undefined}>
      <div className="step-row static">
        <span>{routerLabel} proposes a pipeline</span>
      </div>
      <div className="waiting-note">Waiting for your input…</div>
      <div className="approval-card pulse-once pipeline-card">
        <div className="approval-title">
          <img className="pipeline-teddy" src={routerIcon} alt="" />
          {routerLabel} proposes a pipeline
        </div>
        <ol className="pipeline-steps">
          {steps.map((s, i) => (
            <li className="pipeline-step" key={i}>
              <span className="pipeline-step-num">{i + 1}</span>
              <div className="pipeline-step-body">
                <div className="pipeline-step-head">
                  <span className="pipeline-step-role">{s.role}</span>
                  <span className="pipeline-step-model">
                    {modelDisplay(providers, s.modelRef).name}
                  </span>
                </div>
                <div className="pipeline-step-task">{s.subtask}</div>
              </div>
            </li>
          ))}
        </ol>
        <button className="approval-opt" onClick={approve}>
          {isFirstPending ? <span className="opt-num">1</span> : null}
          Yes, run this pipeline
          <span className="opt-hint">each step runs on its role&apos;s model, in order</span>
        </button>
        <button className="approval-opt" onClick={deny}>
          {isFirstPending ? <span className="opt-num">2</span> : null}
          No, just answer normally
          <span className="opt-hint">runs the turn single-role, as usual</span>
        </button>
      </div>
    </div>
  )
}

// G-skills Task 8: the inline editable /learn approval card. The renderer may
// EDIT the model's drafted name/description/body and pick a scope before
// saving -- the resume carries these FINAL values, never the tool's original
// args (tools.ts's proposeSkillTool writes exactly what the resolution says).
function PendingSkillProposal({
  callId,
  input
}: {
  callId: string
  input: unknown
}): React.JSX.Element {
  const resolve = useAppStore((s) => s.resolveSkillProposal)
  const workspacePath = useAppStore((s) => s.workspacePath)
  const p = (input ?? {}) as { name?: string; description?: string; body?: string }
  const [name, setName] = useState(p.name ?? '')
  const [description, setDescription] = useState(p.description ?? '')
  const [body, setBody] = useState(p.body ?? '')
  const [scope, setScope] = useState<'project' | 'global'>(workspacePath ? 'project' : 'global')
  const kebabOk = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
  const canSave = kebabOk && description.trim() !== ''
  return (
    <div className="step">
      <div className="step-row static">
        <span>/learn: a skill was proposed from this session</span>
      </div>
      <div className="waiting-note">Waiting for your review…</div>
      <div className="approval-card pulse-once skill-proposal-card">
        <div className="approval-title">Save this skill?</div>
        <label className="skill-field">
          <span>Name</span>
          <input className="set-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {!kebabOk && name !== '' ? (
          <div className="set-row-desc">Name must be kebab-case.</div>
        ) : null}
        <label className="skill-field">
          <span>Description</span>
          <input
            className="set-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="skill-field">
          <span>Instructions</span>
          <textarea
            className="set-input skill-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {workspacePath ? (
          <Select
            ariaLabel="Skill scope"
            value={scope}
            options={[
              {
                value: 'project',
                label: 'Project',
                description: 'Written to .agents/skills, shared with the repo'
              },
              { value: 'global', label: 'Global', description: 'Private to you; this machine only' }
            ]}
            onChange={setScope}
          />
        ) : null}
        <div className="approval-actions">
          <button
            className="pill-btn primary"
            disabled={!canSave}
            onClick={() => resolve(callId, { save: true, name, description, body, scope })}
          >
            Save skill
          </button>
          <button className="pill-btn" onClick={() => resolve(callId, { save: false })}>
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}
