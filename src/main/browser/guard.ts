// F4 L2+L3 guard chain (pure). Encodes the browser action decision matrix; the
// tool layer (Task 7) resolves `mode` via resolveConversationMode and the policy
// from settings, then calls this. Session consent (L1) and the L0 enable gate are
// enforced at the tool/manager layer — this function stays pure and side-effect
// free so it is exhaustively unit-testable.
import type { PermissionMode } from '../../shared/types'
import { originDecision, type DomainPolicy } from './policy'

export type BrowserActionKind = 'read' | 'mutate' | 'navigate'

export interface BrowserActionInput {
  kind: BrowserActionKind
  // The conversation's live permission mode (already resolved by the caller).
  mode: PermissionMode
  // navigate only: the destination URL + the effective domain policy.
  url?: string
  policy?: DomainPolicy
}

// SECURITY (design §L3): reads (read/screenshot/scroll/wait + navigate-within-
// policy) are always allowed; navigate is additionally gated by the L2 domain
// policy; mutations (click/type/submit/evaluate) respect the permission mode
// exactly like run_command — plan is read-only (blocks), ask prompts, and
// accept-edits/auto/bypass allow.
export function evaluateBrowserAction(input: BrowserActionInput): 'allow' | 'prompt' | 'block' {
  if (input.kind === 'read') return 'allow'

  if (input.kind === 'navigate') {
    // Default: empty allowlist = allow-all-but-blocklist (matches B4 defaults
    // until real settings policy is wired in Task 11). Navigate is read-class,
    // so the permission mode never blocks it — only the domain policy does.
    const policy: DomainPolicy = input.policy ?? { allowlist: [], blocklist: [] }
    return originDecision(input.url ?? '', policy)
  }

  // kind === 'mutate' — mirror the run_command mode gate.
  switch (input.mode) {
    case 'plan':
      return 'block'
    case 'ask':
      return 'prompt'
    case 'accept-edits':
    case 'auto':
    case 'bypass':
      return 'allow'
    default:
      return 'prompt'
  }
}

// The canonical human-readable label for a browser action, derived purely from
// the tool name + its call input. It is the SINGLE source of truth for the
// action string on both sides of the denied-replay pin: the tool layer passes
// it into the interrupt payload / gate (tools.ts gateBrowserAction), and
// graph.ts deniedReplayPinsOf reconstructs the identical string from a parked
// card's { tool, input } so an id-less browser denial keys its pin under the
// same value the replayed tool consults. Keep the two producers in lockstep by
// routing both through here.
export function browserActionLabel(tool: string, input: unknown): string {
  const o = (input ?? {}) as { ref?: unknown; url?: unknown }
  const ref = typeof o.ref === 'string' ? o.ref : ''
  const url = typeof o.url === 'string' ? o.url : ''
  switch (tool) {
    case 'browser_navigate':
      return `navigate ${url}`
    case 'browser_click':
      return `click ${ref}`
    case 'browser_type':
      return `type into ${ref}`
    case 'browser_evaluate':
      return 'evaluate JavaScript in the page'
    default:
      return tool
  }
}
