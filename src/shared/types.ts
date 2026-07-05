// The contract shared by main, preload, and renderer.
// Change deliberately and update all three layers together.

// Command-name grammar (D2 design 5.1/6.2), shared so the parse-time check
// (a workflow's filename, src/main/agentsDir/parseWorkflow.ts) and the
// wire-time check (the run:start IPC boundary, src/main/ipc.ts) can never
// drift into two different regexes: kebab-case, lowercase letters/digits/
// dashes only, 1-64 characters, must not start with a dash.
export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

// The minimal command slot (D2 design 3.3 deferral, D2 Task 2). A CommandRef
// is exactly design 3.3's future MessageParts.command field shape, so D3's
// full MessageParts can absorb it unchanged: it travels structured end to
// end (run:start argument, the persisted user_message payload) and is never
// concatenated into the message text.
export interface CommandRef {
  name: string
  kind: 'builtin' | 'workflow'
}

// A single @ mention carried alongside the turn's text + command (D3 design
// 3.1/7). Travels structured end to end the SAME additive way CommandRef does
// (run:start argument, the persisted user_message payload) and is never
// concatenated into the message text. `path` is set for kind 'file'
// (workspace-relative); `conversationId` for kind 'conversation'. Both are
// used only as prompt text and (for files) a pure glob-match string — never
// opened at the IPC boundary (see assertValidMentions).
export interface MentionRef {
  kind: 'file' | 'rule' | 'conversation'
  name: string
  path?: string
  conversationId?: string
}

// A single image attachment carried alongside the turn's text + command +
// mentions (D4 design 3.3/8/9). Travels structured end to end the SAME
// additive way CommandRef/MentionRef do (run:start argument, the persisted
// user_message payload) and is never concatenated into the message text. The
// bytes are copied main-side at pick time to userData/attachments/<convId>/<id>
// (id is minted main-side, randomUUID); only this ref travels the wire.
// SECURITY: `id` is used main-side to build that on-disk path, so the run:start
// guard (assertValidAttachments) constrains it to a path-safe pattern.
export interface AttachmentRef {
  id: string
  name: string
  mime: string
}

// The only image mime types D4 accepts (design 8; png/jpg/webp/gif). PDFs are
// phase 2. Shared so the byte-sniff (main ingest) and the wire guard
// (assertValidAttachments) can never drift.
export const ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

// The pick IPC's per-image result: the ref that will be sent + a data URL the
// composer renders as a thumbnail (never persisted, never sent to the model).
export interface PickedAttachmentWire {
  ref: AttachmentRef
  previewDataUrl: string
}

// The @ menu's Rules read model (D3 design 7): Manual-mode rule name + the
// first non-empty line of its body, for the menu row. Produced main-side from
// the live AgentsContent (mentionSuggest.ts manualRuleInfos).
export interface ManualRuleInfo {
  name: string
  firstLine: string
}

// The slash menu's read model (design 6.1/6.2, D2 Task 2). Produced by
// src/main/orchestrator/commands.ts's listCommands from the live
// AgentsContent; 'coming-soon' covers both the not-yet-implemented built-ins
// and any workflow entry that cannot be sent (a parse error or a name
// collision with a built-in) -- greyed in the menu either way.
export interface CommandEntry {
  name: string
  description: string
  kind: 'builtin' | 'workflow'
  status: 'live' | 'coming-soon'
  source?: 'project' | 'global'
  error?: string
}

// The legacy engine's tool set is 'list_dir' | 'read_file' | 'search_files' |
// 'write_file' | 'edit_file' | 'run_command'. The orchestrator engine's tools
// are Deep Agents' always-on built-ins (createDeepAgent() injects these
// regardless of a custom `tools` option: 'ls' | 'read_file' | 'write_file' |
// 'edit_file' | 'glob' | 'grep', a `write_todos` planning tool, and a `task`
// subagent tool) plus one custom 'run_command' tool (src/main/orchestrator
// /tools.ts). Both engines' names are unioned here so a single Event type
// serves either engine.
export type ToolName =
  | 'list_dir'
  | 'read_file'
  | 'search_files'
  | 'write_file'
  | 'edit_file'
  | 'run_command'
  | 'ls'
  | 'glob'
  | 'grep'
  | 'write_todos'
  | 'task'
  | 'submit_plan'
  | 'submit_walkthrough'

export type ApprovalState = 'auto' | 'pending' | 'approved' | 'denied'

// The single per-conversation mode (unified-mode-picker design §3/§4.1). Ask
// and Accept edits both prompt for commands; they differ only on the edit
// fallback (prompt vs apply). Plan is read-only (both fallbacks block). Auto
// runs/applies by default. Bypass skips the rules engine entirely and is the
// one deliberate security hole (design §6) -- per-conversation only, never a
// default (see AppSettings.defaultPermissionMode validation in settings.ts).
export type PermissionMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

export type PermissionRuleEffect = 'allow' | 'deny' | 'ask'

export type PermissionAction = 'command' | 'edit'

// A rule is either global or bound to one project's workspace path.
export type RuleScope = 'global' | { projectPath: string }

export interface PermissionRule {
  id: string
  scope: RuleScope
  action: PermissionAction
  match: string // exact command, or a trailing '*' prefix glob (e.g. 'git *')
  effect: PermissionRuleEffect
  source: 'user' | 'builtin'
}

// What the run_command gate does with a command.
export type CommandDecision = 'run' | 'prompt' | 'block'

// What the file-write gate does with an edit.
export type EditDecision = 'apply' | 'prompt' | 'block'

// The renderer sends this to persist a user rule; main assigns id + source.
export interface AddRuleInput {
  scope: RuleScope
  action: PermissionAction
  match: string
  effect: PermissionRuleEffect
}

// The permissions manager's read model: user rules verbatim, builtins paired
// with their disabled state (the ids live in AppSettings.disabledBuiltins).
export interface BuiltinRuleInfo {
  rule: PermissionRule
  disabled: boolean
}

export interface PermissionRulesInfo {
  userRules: PermissionRule[]
  builtins: BuiltinRuleInfo[]
}

// ---- Artifacts (Ba) ----

// The agent's structured deliverables (design 2026-07-04-ba-artifacts-design.md
// section 3.4). Plans are born 'pending-review' or 'approved' depending on the
// artifact review policy at submit time; walkthroughs are born 'final'.
// 'superseded' marks a still-pending plan that a newer submission replaced.
export type ArtifactType = 'plan' | 'walkthrough'
export type ArtifactStatus = 'pending-review' | 'approved' | 'superseded' | 'final'

export interface Artifact {
  id: string
  conversationId: string
  type: ArtifactType
  version: number // per conversation+type, starts at 1
  title: string
  // Markdown. Rendered ONLY through the renderer's sanitized markdown pipeline
  // (lib/markdown.tsx), the same one chat prose uses -- design section 4.
  body: string
  status: ArtifactStatus
  createdAt: number
  resolvedAt: number | null
}

// Governs what submit_plan does at call time (design 3.3). Read live from
// settings on every submit; never cached.
export type ArtifactReviewPolicy = 'request-review' | 'always-proceed'

// A comment drafted against a plan artifact in the pane (design 3.4). `quote`
// is the selected plan text the comment anchors to (a plain-text anchor, not
// an offset). Comments are drafted locally (sent_at NULL, surviving restarts)
// and delivered as a batch when the user answers the plan review: Proceed
// sends them as steering context, Review sends them as feedback. `sentAt`
// stamps that delivery.
export interface ArtifactComment {
  id: string
  artifactId: string
  quote: string | null
  body: string
  createdAt: number
  sentAt: number | null
}

// Outcome of a plan-review resolution attempt, so the renderer can show
// honest failure copy: 'stale' = the card is no longer answerable (unknown,
// already answered, run stopped, or not a plan card); 'needs-substance' =
// design 3.6's Review guard (needs a comment or a message).
export type PlanReviewResolveResult = 'resolved' | 'needs-substance' | 'stale'

export type RunState = 'running' | 'awaiting-approval' | 'done' | 'error' | 'cancelled'

export type Event =
  | {
      type: 'user_message'
      id: string
      text: string
      createdAt?: number
      // The slash command this turn was sent with, if any (D2 design 3.3/9).
      // Optional and additive: events persisted before D2 have no `command`
      // field and render exactly as before.
      command?: CommandRef
      // The @ mentions this turn was sent with, if any (D3 design 7/9).
      // Optional and additive: events persisted before D3 have no `mentions`
      // field and render exactly as before.
      mentions?: MentionRef[]
      // The image attachments this turn was sent with, if any (D4 design 8/9).
      // Optional and additive: events persisted before D4 have no `attachments`
      // field and render exactly as before.
      attachments?: AttachmentRef[]
    }
  | { type: 'thinking'; id: string; text: string; durationMs: number; agentId?: string }
  | {
      type: 'tool_call'
      id: string
      tool: ToolName
      input: unknown
      approvalState: ApprovalState
      agentId?: string
    }
  | {
      type: 'tool_result'
      id: string
      callId: string
      output: string
      exitCode?: number
      durationMs: number
      truncated: boolean
      // For write_file/edit_file: the staged change, so the step row can
      // render "Created foo.html +28 -0" like a real timeline entry.
      stats?: {
        path: string
        status: 'created' | 'modified' | 'deleted'
        additions: number
        deletions: number
      }
      agentId?: string
    }
  | {
      type: 'file_diff'
      id: string
      diffId: string
      files: {
        path: string
        additions: number
        deletions: number
        status: 'created' | 'modified' | 'deleted'
      }[]
    }
  | {
      type: 'artifact'
      id: string
      artifactId: string
      artifactType: ArtifactType
      version: number
      title: string
      status: ArtifactStatus
      // The full markdown body rides in the event payload (v1 simplicity,
      // design 3.4): the transcript card and the artifacts pane render
      // entirely off the event stream, so Ba1 needs no artifact IPC surface.
      // The artifacts table remains the durable source of truth for Ba2's
      // review loop; this payload is a display copy.
      body: string
    }
  | { type: 'assistant_text'; id: string; text: string; agentId?: string }
  | {
      type: 'turn_meta'
      id: string
      provider: string
      model: string
      startedAt: number
      endedAt: number
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'error'; id: string; message: string; recoverable: boolean }

// ---- Provider layer ----

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama'

export interface ModelInfo {
  id: string
  label: string
}

// A model reference is "provider/modelId"; the modelId itself may contain
// slashes (OpenRouter), so always split on the first slash only.
export type ModelRef = string

export interface ProviderModels {
  id: ProviderId
  displayName: string
  color: string
  requiresKey: boolean
  keyConfigured: boolean
  reachable: boolean
  models: ModelInfo[]
  note?: string
}

// ---- Conversations ----

export interface ConversationMeta {
  id: string
  projectPath: string | null
  title: string | null
  modelRef: ModelRef | null
  createdAt: number
  updatedAt: number
  permissionMode: PermissionMode
  // Pinned Manual rules (.agents rule names). Always [] until the D3 @ menu
  // ships a way to pin them; persisted per conversation in active_rules.
  activeRules: string[]
}

// ---- Diffs ----

export interface FileDiffFile {
  fileId: string
  path: string
  status: 'created' | 'modified' | 'deleted'
  beforeText: string
  afterText: string
  additions: number
  deletions: number
  state: 'applied' | 'reverted'
}

export interface FileDiff {
  diffId: string
  files: FileDiffFile[]
}

// ---- Settings ----

export interface AppSettings {
  ollamaBaseUrl: string
  defaultModelRef: ModelRef | null
  defaultPermissionMode: PermissionMode
  // Ids of builtin deny rules the user explicitly disabled (design 4.3: deny-only
  // builtins are toggleable, with a warning). Filtered out of evaluation at merge
  // time; the rules themselves stay visible in the manager so a disabled builtin
  // is never silent.
  disabledBuiltins: string[]
  // Whether submit_plan holds plans for user review or proceeds immediately
  // (artifacts design 3.3). Read live at each submit call.
  artifactReviewPolicy: ArtifactReviewPolicy
}

export interface SettingsInfo extends AppSettings {
  dataPath: string
}

// ---- IPC surface ----

export interface PingResult {
  message: 'pong'
  electron: string
  node: string
  respondedAt: number
}

export interface BearcodeApi {
  ping(): Promise<PingResult>
  run: {
    start(
      conversationId: string,
      userText: string,
      modelRef: ModelRef,
      projectPath: string | null,
      // The chosen slash command, if any (D2 design 3.3). Main boundary-
      // validates this before a run starts (ipc.ts): only `goal`/`grill-me`
      // builtins and a `workflow`-kind name matching COMMAND_NAME_PATTERN
      // cross the wire; anything else rejects the promise.
      command?: CommandRef | null,
      // The @ mentions this turn was sent with (D3). Main boundary-validates
      // this before a run starts (assertValidMentions); anything malformed
      // rejects the promise.
      mentions?: MentionRef[] | null
      ,
      // The image attachments this turn was sent with (D4). Main boundary-
      // validates this before a run starts (assertValidAttachments); anything
      // malformed rejects the promise.
      attachments?: AttachmentRef[] | null
    ): Promise<void>
    cancel(conversationId: string): Promise<void>
  }
  models: {
    list(): Promise<ProviderModels[]>
  }
  commands: {
    // The slash menu's live read model (design 6.1), re-fetched on menu open:
    // built-ins first, then the project + global workflows for this project
    // (or global-only when projectPath is null).
    list(projectPath: string | null): Promise<CommandEntry[]>
  }
  // D3 @ menu read models, re-fetched on menu interaction (mirrors
  // commands.list): file path suggestions over the gitignore-respecting
  // workspace listing, and the project + global Manual rules.
  mentions: {
    files(projectPath: string | null, query: string): Promise<string[]>
    rules(projectPath: string | null): Promise<ManualRuleInfo[]>
  }
  // D4 Media (design 8): native image picker + main-side ingest, returning the
  // accepted attachments (ref + a preview data URL for the composer thumbnail)
  // and a human-readable error per rejected file. `existingCount` is how many
  // images are already on the composer, so the 5-per-message cap is respected.
  attachments: {
    pick(
      conversationId: string,
      existingCount: number
    ): Promise<{ picked: PickedAttachmentWire[]; errors: string[] }>
    // D4 Media (Task 7): fetch a copied attachment's real bytes as a data:
    // URL, for a transcript pill's thumbnail. A reloaded transcript only has
    // the persisted AttachmentRef (id/name/mime), not bytes. Returns null if
    // the file is gone or not a recognized image.
    read(conversationId: string, id: string): Promise<string | null>
  }
  diffs: {
    get(diffId: string): Promise<FileDiff>
    revert(fileId: string): Promise<void>
    open(fileId: string): Promise<void>
  }
  tools: {
    approve(callId: string, approved: boolean): Promise<void>
  }
  keys: {
    set(provider: ProviderId, key: string): Promise<void>
    status(): Promise<Record<ProviderId, boolean>>
  }
  settings: {
    get(): Promise<SettingsInfo>
    set(patch: Partial<AppSettings>): Promise<SettingsInfo>
  }
  conversations: {
    list(): Promise<ConversationMeta[]>
    get(id: string): Promise<Event[]>
    create(projectPath: string | null): Promise<ConversationMeta>
    delete(id: string): Promise<void>
    clear(): Promise<void>
    setMode(id: string, mode: PermissionMode): Promise<void>
  }
  permissions: {
    addRule(rule: AddRuleInput): Promise<void>
    list(): Promise<PermissionRulesInfo>
    deleteRule(id: string): Promise<void>
    setBuiltinDisabled(id: string, disabled: boolean): Promise<void>
  }
  // Plan-review resolutions ride their OWN channel, never tools.approve: the
  // boolean command/edit approval wire and the plan wire reject each other's
  // cards by kind (graph.ts cross-guards).
  artifacts: {
    resolvePlanReview(
      callId: string,
      proceed: boolean,
      message?: string
    ): Promise<PlanReviewResolveResult>
    addComment(artifactId: string, quote: string | null, body: string): Promise<ArtifactComment>
    listComments(artifactId: string): Promise<ArtifactComment[]>
  }
  workspace: {
    pick(): Promise<string | null>
  }
  onEvent(cb: (conversationId: string, event: Event) => void): () => void
  onRunStateChange(cb: (conversationId: string, state: RunState) => void): () => void
  onConversationMeta(cb: (meta: ConversationMeta) => void): () => void
}
