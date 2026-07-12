// The contract shared by main, preload, and renderer.
// Change deliberately and update all three layers together.

import type { ThemeMode, CustomColors, FontSize, ConversationWidth, ChatFont } from './appearance'
import type { PricingMap } from './pricing'

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
  kind: 'file' | 'rule' | 'conversation' | 'connector' | 'skill'
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
// The lane an attachment rides (D5). Additive: pre-D5 persisted events have no
// `kind` and default to 'image' (see assertValidAttachments + every reader —
// always read as `attachment.kind ?? 'image'`, never assume it is present).
export type AttachmentKind = 'image' | 'text' | 'pdf' | 'office'

export interface AttachmentRef {
  id: string
  name: string
  mime: string
  // Optional for back-compat with pre-D5 persisted refs (see AttachmentKind
  // doc above). Every reader must default a missing kind to 'image'.
  kind?: AttachmentKind
}

// The four byte-sniffed image mimes (D4). Kept under the original name so the
// image byte-sniff (ingest sniffImageMime) and the wire guard never drift.
export const ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
// D5 per-lane allowlists. Binary lanes are byte-sniffed; the text lane is
// routed by extension + a UTF-8-clean gate (never trusts the extension for a
// path or a binary decode).
export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const OFFICE_MIME_TYPES = [DOCX_MIME, XLSX_MIME] as const
export const TEXT_EXTENSIONS = [
  'md',
  'markdown',
  'txt',
  'text',
  'html',
  'htm',
  'css',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'py',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'csv',
  'tsv',
  'sh',
  'bash',
  'zsh',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'rb',
  'php',
  'sql',
  'swift',
  'r',
  'lua',
  'pl'
] as const

// The pick IPC's per-file result: the ref that will be sent + a data URL the
// composer renders as a thumbnail (never persisted, never sent to the model).
export interface PickedAttachmentWire {
  ref: AttachmentRef
  // For images: a data: URL the composer renders as a thumbnail (never
  // persisted, never sent to the model). Empty string for non-image lanes.
  previewDataUrl: string
  // Non-image lanes: a short pick-time badge/notice for the pill (e.g.
  // "PDF · no extractable text", "truncated at 256 KB"). Not persisted.
  notice?: string | null
}

// The @ menu's Rules read model (D3 design 7): Manual-mode rule name + the
// first non-empty line of its body, for the menu row. Produced main-side from
// the live AgentsContent (mentionSuggest.ts manualRuleInfos).
export interface ManualRuleInfo {
  name: string
  firstLine: string
}

// The @skill: menu read model (G-skills Task 6, parallel to ManualRuleInfo).
// Produced main-side from the live AgentsContent (mentionSuggest.ts
// skillInfos), filtered to non-error, enabled skills only.
export interface SkillInfo {
  name: string
  description: string
}

// The Settings > Skills page's list read model (design 4.6): every skill
// (global + project), with its enabled flag, on-disk body size, and any parse
// error (parse-errored skills are still listed, greyed, with the error shown).
export interface SkillEntry {
  name: string
  description: string
  source: 'project' | 'global'
  enabled: boolean
  sizeBytes: number
  error?: string
  // The skill's current on-disk body (empty string for a parse-errored entry
  // whose body couldn't be extracted). Carried so the Settings page's Edit
  // affordance can pre-fill the editor without wiping the user's content
  // (design 4.6 / Task 9 fix).
  body: string
  // Set when this skill was folded in from an enabled plugin (Phase G plugins
  // arc, Task 5) rather than a direct .agents/ skill. Carries the plugin's
  // on-disk dirName; the Settings page renders a provenance badge and
  // disables edit/delete (managed via the plugin, not this page).
  plugin?: string
}

// The Settings > Rules page's list read model (Phase G plugins arc, Task 12
// fix). Rules (.agents/rules/*.md, project + global) are file-managed only --
// there is no create/edit/delete surface here, mirroring workflows -- so this
// is read-only, but it's the one place a user can see every live rule (name,
// activation mode, scope) and, for a plugin-sourced one, which plugin owns it
// (parallel to SkillEntry.plugin / McpServerConfig.plugin).
export interface RuleEntry {
  name: string
  description: string
  activation: 'always' | 'manual' | 'model' | 'glob'
  source: 'project' | 'global'
  error?: string
  plugin?: string
}

// Create/update payload for a skill (Settings page editor + /learn's proposal
// card, Task 8).
export interface SkillInput {
  name: string
  description: string
  body: string
  scope: 'project' | 'global'
}

export type MemoryScopeName = 'global' | 'project'

// One bullet in a scope's memory.md. `index` is the 0-based position within
// its scope file — the stable handle edit/delete/promote address (v1 has no
// per-entry provenance metadata, out of scope).
export interface MemoryEntry {
  scope: MemoryScopeName
  index: number
  text: string
}

export interface MemoryScope {
  entries: MemoryEntry[]
  sizeBytes: number
}

export interface MemoryList {
  global: MemoryScope
  project: MemoryScope
}

// Promote-a-bullet payload (Task 6): turns a memory entry into a Rule or a
// Skill, then drops the source bullet.
export type PromoteTarget = 'rule' | 'skill'

export interface MemoryPromoteInput {
  scope: MemoryScopeName
  index: number
  target: PromoteTarget
  name: string // kebab-case; rule/skill filename or folder
  description?: string // required for skill (SKILL.md), unused for rule
}

// The renderer's resolution of a pending propose_skill card (Task 8), mirror
// of PlanReviewResolution's truthy-object contract: both variants are truthy
// (LangGraph's mapCommand drops falsy resume values), so a discarded proposal
// still resumes with { save: false } rather than an empty/undefined value.
// The user may have EDITED name/description/body and picked a scope; these
// final values ride the resolution, never the tool's original args.
export type SkillProposalResolution =
  | { save: true; name: string; description: string; body: string; scope: 'project' | 'global' }
  | { save: false }

// The discriminant bearcode:skills:save returns: 'resolved' once the card is
// answered and the resolution recorded, 'stale' when no matching pending
// propose_skill card exists (already answered / conversation gone).
export type SkillSaveResult = 'resolved' | 'stale'

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
  | 'browser_navigate'
  | 'browser_read'
  | 'browser_screenshot'
  | 'browser_scroll'
  | 'browser_wait'
  | 'browser_click'
  | 'browser_type'
  | 'browser_evaluate'
  | 'github_list_repos'
  | 'github_list_prs'
  | 'github_get_issue'
  | 'github_create_pr'
  | 'bitbucket_list_repos'
  | 'bitbucket_create_pr'
  | 'propose_skill'
  | 'remember'

export type ApprovalState = 'auto' | 'pending' | 'approved' | 'denied'

// The single per-conversation mode (unified-mode-picker design §3/§4.1). Ask
// and Accept edits both prompt for commands; they differ only on the edit
// fallback (prompt vs apply). Plan is read-only (both fallbacks block). Auto
// runs/applies by default. Bypass skips the rules engine entirely and is the
// one deliberate security hole (design §6) -- per-conversation only, never a
// default (see AppSettings.defaultPermissionMode validation in settings.ts).
export type PermissionMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

// Per-conversation reasoning effort (E6). 'adaptive' sends NO effort param
// (model self-paces — today's behavior); the five tiers map to the provider's
// reasoning knob where supported (Anthropic-native this phase). 'xhigh' shows
// as "Extra" in the UI. See planning/2026-07-05-e1e6-effort-composer-design.md.
export type EffortLevel = 'adaptive' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type PermissionRuleEffect = 'allow' | 'deny' | 'ask'

export type PermissionAction = 'command' | 'edit' | 'mcp' | 'integration' | 'unsandboxed'

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

// ---- MCP (Connectors) ----

export type McpTransport = 'http' | 'stdio'
export interface McpServerConfig {
  name: string
  transport: McpTransport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  source: 'global' | 'project'
  // Set when this server was contributed by an enabled plugin's mcp.json
  // rather than a direct global/project config (Phase G plugins arc). Carries
  // the plugin's on-disk dirName. A plugin-sourced server is UNTRUSTED by
  // default regardless of `source` -- see isTrusted in mcp/store.ts.
  plugin?: string
}
// A server found via read-only discovery of configs BearCode itself did not
// write (Task 13 / design §8 G3): a project's `<proj>/.mcp.json` or the
// Claude Desktop config. Never persisted as-is -- `origin` records where it
// came from so the picker can label it and import can pick a target scope.
export interface DiscoveredMcpServer {
  name: string
  origin: 'claude-desktop' | 'project-mcp-json'
  transport: McpTransport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}
export interface McpToolInfo {
  name: string
  description: string
  readOnlyHint: boolean
}
export type McpServerStatus =
  | { state: 'disabled' }
  | { state: 'untrusted' }
  | { state: 'connected'; tools: McpToolInfo[] }
  // A remote (OAuth) server that hit a 401 and is now mid sign-in: the system
  // browser is open and the manager is awaiting the loopback redirect. The
  // Connectors row shows "Signing in…". Clears to 'connected' on success or
  // 'error' on cancel/timeout/token-exchange failure.
  | { state: 'authorizing' }
  | { state: 'error'; message: string }
export interface McpServerView {
  config: McpServerConfig
  enabled: boolean
  status: McpServerStatus
  // Whether the user has granted one-time spawn consent for this (stdio)
  // server, so the renderer can skip re-prompting on every enable toggle.
  spawnConsented: boolean
}
// Smithery registry search hit (Task 11 fills in the client; the shape is
// pinned here since the IPC/BearcodeApi surface (Task 8) needs it up front).
export interface SmitheryHit {
  id: string
  name: string
  description: string
  toolCount?: number
  transport: McpTransport
  iconUrl?: string | null
  useCount?: number
  verified?: boolean
}

// Integrations (GitHub/Bitbucket, Task 11): the wire-facing read model for a
// provider's connection state. Mirrors main/integrations/store.ts's
// IntegrationState exactly (structurally, not by import -- main's copy owns
// the source of truth) but lives here since it crosses the IPC boundary.
// NEVER carries a token: the vaulted token has no getter on this surface at
// all (design §2/§8, matching the mcp secrets contract).
export type IntegrationProvider = 'github' | 'bitbucket'
export interface IntegrationStatus {
  provider: IntegrationProvider
  connected: boolean
  method?: 'device' | 'pat' | 'app-password'
  login?: string
  scopes?: string[]
  connectedAt?: number
}

// GitHub Device Flow start response (Task 7 githubDeviceStart), surfaced to
// the Integrations page's connect modal so the user can see + enter the code.
export interface GithubDeviceStart {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
}

// ---- Plugins (Phase G plugins arc) ----
// A plugin is a `plugins/<name>/` directory (`plugin.json` marker + optional
// `skills/`, `rules/`, `mcp.json`, `hooks.json`). These summary shapes are pure
// metadata for discovery/the install-review card -- never anything executable.
export interface PluginServerSummary {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
}
export interface PluginSkillSummary {
  name: string
  description: string
  // Actual on-disk folder name under `<plugin>/skills/`, which the loader
  // bridge (enumeratePluginIngredients) needs to build a real path from --
  // `name` above may differ from it (frontmatter `name:` override, design
  // 4.1) and must never be used to address the filesystem.
  folder: string
}
export interface PluginRuleSummary {
  name: string
  activation: 'always' | 'manual' | 'model' | 'glob'
}
export interface PluginManifest {
  name: string
  description?: string
  version?: string
  scope: 'global' | 'project'
  skills: PluginSkillSummary[]
  rules: PluginRuleSummary[]
  servers: PluginServerSummary[]
  hookCount: number
}
export interface PluginEntry extends PluginManifest {
  enabled: boolean
  source?: string
  // Canonical identity for enable-state/uninstall: the actual scanned
  // directory name on disk, NOT the (attacker/author-controlled) manifest
  // `name` field. `name` above stays a display label only.
  dirName: string
  // Whether Update can actually do anything: only a plugin whose install
  // carries a `.git` dir (a direct clone) can be `git pull`ed. A
  // marketplace-subpath install's `cpSync` copy has no `.git`, so
  // updatePlugin is a silent no-op for it -- the UI hides/disables Update
  // rather than offering an action that never does anything.
  updatable: boolean
}
// Result of a plugin update attempt (main/plugins/marketplace.ts
// updatePlugin): 'not-updatable' when the install has no `.git` (a
// marketplace-subpath cpSync copy) to `git pull`.
export type PluginUpdateResult = 'updated' | 'not-updatable'
// A catalog hit surfaced by a marketplace's marketplace.json (Task 7/8).
export interface MarketplacePlugin {
  name: string
  description: string
  source: string
  marketplaceUrl: string
  // Optional catalog hint (Task 11 of the hooks arc): lets BrowsePluginsModal
  // filter to skill-only entries in 'skills' mode. Undefined when the
  // marketplace.json entry doesn't declare it -- such entries only ever show
  // in 'plugins' mode.
  kind?: 'skill' | 'plugin'
}

// ---- Hooks (Phase G hooks arc) ----
// Tool-lifecycle hooks: user-registered shell commands that fire at the
// agent's tool-execution boundary (PreToolUse/PostToolUse). Hooks can only
// TIGHTEN a permission decision (deny/ask), never bypass it -- a broken,
// timed-out, or malformed hook fails OPEN (proceeds to normal permission
// eval). Only the 'command' handler type exists (design §9: no injectSteps).
export type HookEvent = 'PreToolUse' | 'PostToolUse'
export type HookDecisionKind = 'allow' | 'deny' | 'ask'
export interface HookHandler {
  type: 'command'
  command: string
  timeout?: number
}
export interface HookEventEntry {
  matcher?: string
  handler: HookHandler
}
export interface HookConfig {
  enabled?: boolean
  PreToolUse?: HookEventEntry[]
  PostToolUse?: HookEventEntry[]
}
// One flattened (name, event, matcher) hook, ready to run. `plugin` is set
// only when scope === 'plugin' (the owning plugin's dirName). `consented`
// reflects the current enable/consent state (state.ts): global hooks default
// on, project/plugin hooks default off until the user explicitly consents.
export interface HookRecord {
  name: string
  scope: 'global' | 'project' | 'plugin'
  plugin?: string
  event: HookEvent
  matcher: string
  command: string
  timeout: number
  consented: boolean
}
export interface HookDecision {
  decision: HookDecisionKind
  reason?: string
}
// Wire shape for authoring/editing a GLOBAL hook (Settings > Hooks form and
// bearcode:hooks:create/update). Project/plugin hooks.json files stay
// file-managed and are never authored through this input (design §2 decision
// #3). Structurally matches main/hooks/authoring.ts's WriteGlobalHookInput.
export interface HookAuthoringInput {
  name: string
  event: HookEvent
  matcher: string
  command: string
  timeout?: number
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
      sandboxed?: boolean
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
      usage?: { inputTokens: number; outputTokens: number; lastInputTokens: number }
    }
  | { type: 'error'; id: string; message: string; recoverable: boolean }
  // Optional & additive marker emitted when the summarization middleware folds
  // the oldest `summarizedCount` messages into a summary (auto-compaction).
  // Older event streams simply lack it; renderers must handle its absence.
  | { type: 'compaction'; id: string; summarizedCount: number; createdAt?: number }

// ---- Provider layer ----

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama'

export interface ModelInfo {
  id: string
  label: string
  // Approximate context window in tokens (E11). Optional: dynamic/unknown
  // models (ollama, openrouter) omit it and the context meter stays hidden.
  contextWindow?: number
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

// ---- Model management (F7) ----

// A user-added model merged into a provider's curated list. Custom wins on id
// collision with a curated model (a single merged entry).
export interface CustomModel {
  provider: ProviderId
  id: string
  label: string
  contextWindow: number
}

// One row in the Models settings page's management list. Unlike ProviderModels
// (the effective/visible set), this includes disabled models so the user can
// toggle them back on.
export interface ManageableModel {
  id: string
  label: string
  contextWindow?: number
  custom: boolean // user-added (removable) vs curated (toggle-only)
  enabled: boolean // false when its ref is in disabledModels
}

export interface ManageableProvider {
  id: ProviderId
  displayName: string
  color: string
  models: ManageableModel[]
}

// ---- Projects (E4) ----

// The settable subset of a Project (what the Project Settings modal writes and
// what AppSettings.newProjectDefaults holds as the new-project template). Every
// field optional so a patch touches only what changed; a null clears an override.
export interface ProjectSettings {
  name?: string | null // custom display-name override; null → use the folder basename
  color?: string | null
  icon?: string | null
  defaultModelRef?: ModelRef | null
  defaultEffort?: EffortLevel | null
  defaultPermissionMode?: PermissionMode | null
  // Sandbox Mode (macOS Seatbelt). Per-project; global default off.
  sandboxMode?: boolean | null
  sandboxAllowNetwork?: boolean | null
  // Project Trust (audit C-1). Secure default: untrusted / ask.
  trusted?: boolean | null
  outsideFolderAccess?: OutsideFolderAccess | null
}

// F9 (folder = project): per-folder settings keyed by the workspace PATH. A
// folder with no stored row resolves to all-null (inherit global). See memory
// bearcode-folder-equals-project. Supersedes the E4 named-Project entity.
export interface FolderProject {
  path: string
  name: string | null
  color: string | null
  icon: string | null
  defaultModelRef: ModelRef | null
  defaultEffort: EffortLevel | null
  defaultPermissionMode: PermissionMode | null
  sandboxMode: boolean
  sandboxAllowNetwork: boolean
  trusted: boolean
  outsideFolderAccess: OutsideFolderAccess
  outsideFolderAllowedPaths: string[]
  outsideFolderDeniedPaths: string[]
  outsideFolderPendingPaths: string[]
}

// Project Trust + Outside-of-Folder Access (audit C-1). See
// planning/2026-07-11-project-trust-design.md.
export type OutsideFolderAccess = 'allow' | 'ask' | 'deny'
export interface OutsideAccessInfo {
  policy: OutsideFolderAccess
  allowed: string[]
  denied: string[]
  pending: string[]
}

// F3: an isolated git worktree spawned for a conversation running in Worktree
// mode. One per discovered repo; empty for Local mode (or a non-git project).
export interface WorktreeInfo {
  repoPath: string
  worktreePath: string
  branch: string
  baseBranch: string
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
  // Per-conversation reasoning effort + thinking toggle (E6). Resolved from the
  // effort/thinking columns, falling back to the settings defaults (db toMeta).
  effort: EffortLevel
  thinking: boolean
  // The project this conversation belongs to (E4), or null when unassigned.
  projectId: string | null
  // Pin/archive flags (E7). Pinned conversations float to the top of their
  // group; archived conversations are excluded from all sidebar groups.
  pinned: boolean
  archived: boolean
  // A short snippet of the first user message (F1 History browse), sourced from
  // the DB so the browse list shows a preview even for conversations that were
  // never opened this session (their in-memory events are empty). null when the
  // conversation has no user message yet, or when the meta wasn't built with a
  // preview (e.g. single-conversation reads that don't need it).
  preview?: string | null
  // F3: execution environment, chosen at creation and locked after start.
  // 'local' runs in the project folder; 'worktree' runs in isolated git
  // worktrees (see `worktrees`). Defaults to 'local'.
  environment: 'local' | 'worktree'
  // F3: the spawned worktrees for this conversation (empty in local mode, or
  // when the project has no git repo so worktree mode fell back to local).
  worktrees: WorktreeInfo[]
}

// ---- Conversation history search (F1) ----

// One ranked full-text hit from searchHistory: the matched event, its host
// conversation's display meta, and a snippet with the matched term wrapped in
// the ‹mark›…‹/mark› sentinels the renderer parses into <mark> nodes.
export interface HistoryHit {
  conversationId: string
  eventId: string
  kind: Event['type']
  snippet: string
  title: string | null
  projectLabel: string
  updatedAt: number
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

// E9: read-only rendered preview of a created/modified file's real content
// (as opposed to a text diff), for binary types (docx/xlsx/pdf/images) whose
// diff is just a "(binary: …)" marker.
export type PreviewPayload =
  | { kind: 'text'; text: string; truncated?: boolean }
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'html'; html: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf'; dataUrl: string }
  | { kind: 'unsupported'; note: string }

// ---- Settings ----

// Speech-to-text backend for voice input (E5). 'openai' uses the hosted Whisper
// API via the existing OpenAI key (the guaranteed-working default); 'local' runs
// an offline on-device model (best-effort). Shared so the settings coercion and
// the main-side transcribe router never drift on the valid set.
export type SttBackend = 'openai' | 'local'
export const STT_BACKENDS: readonly SttBackend[] = ['openai', 'local']
export const isSttBackend = (v: unknown): v is SttBackend =>
  typeof v === 'string' && (STT_BACKENDS as readonly string[]).includes(v)

// F8 Agent Settings — a friendly layer over the existing PermissionMode + rules.
// SecurityPreset is a named bundle configuring the three primitives below;
// editing any individual control flips the preset to 'custom'.
export type SecurityPreset = 'default' | 'full-autonomy' | 'custom'
// Effect for file actions whose resolved path is OUTSIDE the project root.
// Governs READS only (writes are always jailed to the root); the hard security
// floor (.env/.git denies, jail containment for writes) is never overridden.
export type FileAccessPolicy = 'deny' | 'ask' | 'allow'
// Whether run_command auto-executes under auto mode, or the auto fallback is
// downgraded to the approval card. Only ever tightens the auto-mode fallback.
export type TerminalAutoExec = 'require-review' | 'auto'
export const SECURITY_PRESETS: readonly SecurityPreset[] = ['default', 'full-autonomy', 'custom']
export const FILE_ACCESS_POLICIES: readonly FileAccessPolicy[] = ['deny', 'ask', 'allow']
export const TERMINAL_AUTO_EXECS: readonly TerminalAutoExec[] = ['require-review', 'auto']
export const isSecurityPreset = (v: unknown): v is SecurityPreset =>
  typeof v === 'string' && (SECURITY_PRESETS as readonly string[]).includes(v)
export const isFileAccessPolicy = (v: unknown): v is FileAccessPolicy =>
  typeof v === 'string' && (FILE_ACCESS_POLICIES as readonly string[]).includes(v)
export const isTerminalAutoExec = (v: unknown): v is TerminalAutoExec =>
  typeof v === 'string' && (TERMINAL_AUTO_EXECS as readonly string[]).includes(v)

// Discriminated payload for the voice:transcribe IPC. The OpenAI path sends the
// recorded container bytes verbatim ('webm'); the local path decodes to raw
// 16 kHz mono PCM in the RENDERER (Chromium decodes Opus; Node main cannot) and
// sends the Float32Array's ArrayBuffer ('pcm'). The `kind` tag also hard-routes
// the backend main-side, so a payload always reaches the engine that can read it.
export type TranscribeMeta =
  { kind: 'webm'; mimeType: string } | { kind: 'pcm'; sampleRate: number }

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
  // Global defaults new conversations inherit for the E6 effort/thinking control.
  // No Settings UI this phase; present for consistency + future use.
  defaultEffort: EffortLevel
  defaultThinking: boolean
  // Sidebar Display Options (E3). Persisted per-user.
  // F3: widened to group by 'environment' (Local/Worktree) or 'status'
  // (Active/Idle/Error) buckets.
  sidebarGroupBy: 'project' | 'environment' | 'status' | 'none'
  sidebarSort: 'updated' | 'alpha' | 'created'
  // Show archived conversations in the sidebar (E7c). Default false: archived
  // conversations are hidden from every group (today's behavior) until the
  // user opts in via Display Options.
  sidebarShowArchived: boolean
  // F3: sidebar row subtitle. 'worktree' shows the conversation's worktree
  // branch under the title. Default 'none'.
  sidebarSubtitle: 'none' | 'worktree'
  // Appearance (theme + display). Applied live in the renderer by the appearance
  // apply module; persisted per-user. See src/shared/appearance.ts.
  theme: ThemeMode
  customColors: CustomColors // used when theme === 'custom'; surfaces derive from these
  fontSize: FontSize
  conversationWidth: ConversationWidth
  reduceMotion: boolean
  chatFont: ChatFont
  // Per-model pricing overrides (USD per 1M tokens), keyed by modelRef. Populated
  // by the Settings "Sync prices" button from LiteLLM; wins over the bundled
  // defaults in src/shared/pricing.ts. Optional & additive: settings persisted
  // before this feature load unchanged (coerced to {} / 0).
  modelPricing?: PricingMap
  modelPricingSyncedAt?: number
  // Voice input STT backend (E5). Optional & additive: settings persisted before
  // this feature load unchanged (coerced to 'openai', the guaranteed default).
  sttBackend?: SttBackend
  // General tab (F6): user profile + global custom instructions, folded into the
  // orchestrator system prompt. Optional & additive: coerced to '' on read.
  profileName?: string
  // How BearCode should address the user (may differ from profileName).
  profileCallMe?: string
  // Free-form instructions the user wants followed in every conversation.
  customInstructions?: string
  // F7 model management. Model refs the user opted OUT of (hidden everywhere the
  // effective model set is read: picker, default-model, pricing, context meter).
  // Optional & additive: settings persisted before this feature coerce to [].
  disabledModels?: string[]
  // User-added models merged into the curated lists (custom wins on id collision).
  customModels?: CustomModel[]
  // F8 Agent Settings (global defaults; per-project overrides = F9). Optional &
  // additive: absent → behavior-preserving defaults (custom / deny / auto).
  securityPreset?: SecurityPreset
  fileAccessPolicy?: FileAccessPolicy
  terminalAutoExec?: TerminalAutoExec
  // F9 template applied to every newly created project ("set as default for new
  // projects"). Optional & additive.
  newProjectDefaults?: ProjectSettings
  // F4 browser tool: the L0 enable gate (design §L0). Off by default — the
  // embedded browser never launches, and every browser_* tool refuses, until
  // the user explicitly opts in. Optional & additive.
  browserEnabled?: boolean
  // F4 browser tool: the L2 domain policy (design §L2). An empty allowlist
  // means "allow all but blocklist"; a non-empty allowlist restricts navigate
  // to those origins. Optional & additive: absent -> [] (allow-all-but-block).
  browserAllowlist?: string[]
  browserBlocklist?: string[]
  // Connectors/MCP (G1 core, design 2026-07-09-connectors-mcp-design.md): the
  // master enable gate + per-server enabled/trust/spawn-consent state.
  // Optional & additive.
  mcpEnabled?: boolean
  mcpEnabledServers?: string[]
  mcpTrustedProjectServers?: Record<string, string[]>
  // Global servers are trusted by default (the user added them at the app
  // level), EXCEPT those installed from the Smithery registry: their url/command
  // comes from an untrusted registry response, so they are recorded here and
  // stay untrusted (L2 trust-gated) until the user explicitly trusts them.
  mcpUntrustedGlobalServers?: string[]
  mcpSpawnConsented?: string[]
  // Plugin-sourced MCP servers (Phase G plugins arc) are untrusted by default
  // regardless of scope (a plugin bundle's url/command is author-supplied,
  // not user-typed) -- explicit per-server opt-in, keyed "<pluginDirName>:
  // <serverName>". Optional & additive.
  mcpTrustedPluginServers?: string[]
  // Optional override for the GitHub Device Flow OAuth App client_id (public/
  // secret-free). Empty → the shipped placeholder; the PAT path needs none.
  githubClientId?: string
  // Skills (G-skills, design 4.3): the disabled-set. Global-scope disabled skill
  // names, and a path-keyed map of disabled project-scope skill names (path-keyed
  // like mcpTrustedProjectServers). Optional & additive.
  skillsDisabledGlobal?: string[]
  skillsDisabledProject?: Record<string, string[]>
  // Plugins (Phase G plugins arc): the enabled-set, keyed "<scope>:<name>"
  // (mirrors mcpEnabledServers' string[] idiom -- default DISABLED, a freshly
  // installed plugin never auto-activates). `marketplaces` is the list of
  // git-repo marketplace URLs the user has added. Optional & additive.
  pluginsEnabled?: string[]
  marketplaces?: string[]
  // Hooks (Phase G hooks arc): the enable/consent sets. Global hooks default
  // ON (active unless named here); project/plugin hooks default OFF (active
  // only once consented here). `hooksConsented` keys are
  // "<scope>:<source>:<name>" (source = projectPath for project, plugin
  // dirName for plugin). Optional & additive.
  hooksDisabledGlobal?: string[]
  hooksConsented?: string[]
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
      mentions?: MentionRef[] | null,
      // The image attachments this turn was sent with (D4). Main boundary-
      // validates this before a run starts (assertValidAttachments); anything
      // malformed rejects the promise.
      attachments?: AttachmentRef[] | null
    ): Promise<void>
    cancel(conversationId: string): Promise<void>
  }
  models: {
    list(): Promise<ProviderModels[]>
    // F7: full curated + custom set per first-party provider, incl. disabled
    // models (with an `enabled` flag) so the Models page can toggle them.
    manageable(): Promise<ManageableProvider[]>
  }
  history: {
    search(query: string): Promise<HistoryHit[]>
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
    skills(projectPath: string | null): Promise<SkillInfo[]>
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
    previewFile(fileId: string): Promise<PreviewPayload>
  }
  // E10: Cmd-click a file reference (DiffCard row / Changes pane tab) to open
  // it in the OS default app. Jail-validated in main against the
  // conversation's workspace root (see ipc.ts's 'bearcode:shell:open-file').
  shell: {
    openFile(conversationId: string, path: string): Promise<void>
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
  pricing: {
    sync(): Promise<{ syncedCount: number; unmatched: string[]; syncedAt: number }>
  }
  conversations: {
    list(): Promise<ConversationMeta[]>
    get(id: string): Promise<Event[]>
    create(projectPath: string | null, id?: string): Promise<ConversationMeta>
    delete(id: string): Promise<void>
    clear(): Promise<void>
    setMode(id: string, mode: PermissionMode): Promise<void>
    setEffort(id: string, effort: EffortLevel): Promise<void>
    setThinking(id: string, thinking: boolean): Promise<void>
    // F3: chosen at create, locked at first run. Worktrees are provisioned
    // main-side (the renderer never shells out), so this takes only the
    // environment and returns the updated meta with the resolved worktrees.
    setEnvironment(id: string, environment: 'local' | 'worktree'): Promise<ConversationMeta>
    setPinned(id: string, pinned: boolean): Promise<void>
    setArchived(id: string, archived: boolean): Promise<void>
    rename(id: string, title: string): Promise<void>
  }
  // F9 (folder = project): per-folder settings keyed by workspace path. `list`
  // returns only folders that have a stored settings row; folders with none
  // resolve to all-null in the renderer. `update` upserts the row and returns it.
  projects: {
    list(): Promise<FolderProject[]>
    update(path: string, patch: ProjectSettings): Promise<FolderProject>
  }
  project: {
    isTrusted(path: string): Promise<boolean>
    trust(path: string): Promise<FolderProject>
    untrust(path: string): Promise<FolderProject>
    hasConfig(path: string): Promise<boolean>
    outsideAccess: {
      get(path: string): Promise<OutsideAccessInfo>
      set(path: string, policy: OutsideFolderAccess): Promise<OutsideAccessInfo>
      allow(path: string, abs: string): Promise<OutsideAccessInfo>
      deny(path: string, abs: string): Promise<OutsideAccessInfo>
      list(path: string): Promise<OutsideAccessInfo>
      remove(path: string, abs: string): Promise<OutsideAccessInfo>
    }
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
  // Voice input (E5): the composer records mic audio and hands the ArrayBuffer
  // to main, which routes it to the selected STT backend and returns the
  // transcript text. Transcription runs main-side only (renderer never holds
  // the API key). `meta` tags the payload: 'webm' (raw container → OpenAI) or
  // 'pcm' (renderer-decoded 16 kHz mono float → local Whisper).
  voice: {
    transcribe(audio: ArrayBuffer, meta: TranscribeMeta): Promise<{ text: string }>
  }
  workspace: {
    pick(): Promise<string | null>
  }
  clipboard: {
    write(text: string): Promise<void>
  }
  // F3: worktree lifecycle beyond create. `discard` tears down the spawned
  // worktrees (removes each + its branch) and resets the conversation to local.
  worktree: {
    // F3: merge this repo's worktree branch into its base branch (per-repo so
    // multi-repo merges are independent). 'conflict' returns the conflicted
    // files for the resolver; the merge is left in progress in the base repo.
    merge(
      convId: string,
      repoPath: string
    ): Promise<{ status: 'clean' | 'conflict'; conflictedFiles: string[] }>
    // F3: read a conflicted file's current (marker-laden) text from the base repo.
    readConflict(convId: string, repoPath: string, file: string): Promise<{ merged: string }>
    // F3: write the user's resolved content for a conflicted file + `git add` it.
    resolveFile(convId: string, repoPath: string, file: string, content: string): Promise<void>
    // F3: commit the in-progress merge once all conflicts are resolved.
    completeMerge(convId: string, repoPath: string): Promise<void>
    // F3: abort the in-progress merge, restoring the base repo's pre-merge state.
    abort(convId: string, repoPath: string): Promise<void>
    discard(convId: string): Promise<void>
    // F3: whether New-Worktree mode is offerable for a folder — git is present
    // AND the folder (or an immediate child) is a git repo. Drives the composer
    // env picker's grayed-out state.
    available(path: string): Promise<boolean>
  }
  // F4: the embedded browser pane. The WebContentsView is a main-side singleton
  // driven by Playwright over CDP (browserManager). The renderer owns only the
  // pane's geometry (`setBounds` from the placeholder rect) and visibility
  // (`show`/`hide` on mount/unmount); `status` backs the Settings tab, and
  // `clearSession` wipes the per-conversation browsing data.
  browser: {
    status(): Promise<{
      installed: boolean
      connected: boolean
      conversationId: string | null
      // Whether the CDP endpoint was opened at boot; diverges from the live
      // `browserEnabled` setting after a toggle, gating the relaunch note.
      debuggingEnabled: boolean
    }>
    clearSession(): Promise<void>
    setBounds(b: { x: number; y: number; width: number; height: number }): Promise<void>
    show(): Promise<void>
    hide(): Promise<void>
  }
  // Connectors (MCP): global+project config CRUD, enable/trust/spawn-consent
  // state, live status, secrets (write-only -- there is no getter), and the
  // Smithery registry browse/install surface (Tasks 11/12 fill in the
  // underlying implementation; this shape is the full contract).
  mcp: {
    list(projectPath: string | null): Promise<McpServerView[]>
    ensureConnected(projectPath: string | null): Promise<McpServerView[]>
    add(cfg: McpServerConfig, projectPath: string | null): Promise<void>
    remove(name: string, source: 'global' | 'project', projectPath: string | null): Promise<void>
    setEnabled(name: string, on: boolean, projectPath: string | null): Promise<McpServerStatus>
    trust(name: string, projectPath: string): Promise<McpServerStatus>
    // Trust a global server that was installed pending trust (a Smithery global
    // install). Project-scoped trust uses trust() with the project path.
    trustGlobal(name: string): Promise<McpServerStatus>
    // Trust / revoke trust for a plugin-sourced server (untrusted by default
    // regardless of scope -- see store.ts isTrusted's `plugin` branch), keyed
    // on the plugin-qualified name.
    trustPlugin(plugin: string, name: string): Promise<McpServerStatus>
    untrustPlugin(plugin: string, name: string): Promise<McpServerStatus>
    spawnConsent(name: string): Promise<void>
    reconnect(name: string, projectPath: string | null): Promise<McpServerStatus>
    // (Re)trigger the OAuth sign-in for a remote server that needs it: opens
    // the system browser, captures the loopback redirect, exchanges the code,
    // vaults the tokens, and reconnects. No token ever crosses this IPC — the
    // result is only the resulting status. Remote (http) servers only.
    authorize(name: string, projectPath: string | null): Promise<McpServerStatus>
    status(name: string): Promise<McpServerStatus>
    setSecret(vaultKey: string, value: string): Promise<void>
    smitherySearch(query: string): Promise<SmitheryHit[]>
    smitheryInstall(id: string, projectPath: string | null): Promise<McpServerView>
    // Task 13: read-only discovery of MCP servers already configured elsewhere
    // (a project's `.mcp.json`, the Claude Desktop config) and import of the
    // user's selection through the SAME store + trust/consent gates as any
    // other server.
    discover(projectPath: string | null): Promise<DiscoveredMcpServer[]>
    import(servers: DiscoveredMcpServer[], projectPath: string | null): Promise<McpServerView[]>
  }
  // Integrations (GitHub/Bitbucket, Task 11): status read model + the connect/
  // disconnect flows. No token ever crosses this surface -- IntegrationStatus
  // carries only connected/method/login/scopes/connectedAt, matching the mcp
  // secrets contract (setSecret is write-only there; there is no getter here
  // at all).
  integrations: {
    status(): Promise<IntegrationStatus[]>
    // Starts a GitHub Device Flow: returns the user code + verification URL to
    // show, and the device code + poll interval to pass to githubDevicePoll.
    githubDeviceStart(): Promise<GithubDeviceStart>
    // Blocks (main-side) until the user approves/denies at github.com/login/
    // device or the code expires; honors slow_down internally. Resolves the
    // connected status on success, vaulting the token main-side.
    githubDevicePoll(deviceCode: string, interval: number): Promise<IntegrationStatus>
    cancelGithubDevice(deviceCode: string): Promise<void>
    githubConnectPat(token: string): Promise<IntegrationStatus>
    connectBitbucket(username: string, appPassword: string): Promise<IntegrationStatus>
    disconnect(provider: IntegrationProvider): Promise<void>
  }
  // Skills CRUD (G-skills Task 6): the Settings > Skills page's list +
  // create/update/delete/enable-toggle. Every write is path-jailed and
  // kebab-name validated main-side (skills/index.ts); `save(...)` is added in
  // Task 8 for the /learn proposal card.
  skills: {
    list(projectPath: string | null): Promise<SkillEntry[]>
    create(input: SkillInput, projectPath: string | null): Promise<SkillEntry>
    update(originalName: string, input: SkillInput, projectPath: string | null): Promise<SkillEntry>
    delete(name: string, source: 'project' | 'global', projectPath: string | null): Promise<void>
    setEnabled(
      name: string,
      source: 'project' | 'global',
      projectPath: string | null,
      enabled: boolean
    ): Promise<void>
    save(callId: string, resolution: SkillProposalResolution): Promise<SkillSaveResult>
  }
  // Settings > Rules page's read-only list (Phase G plugins arc, Task 12 fix):
  // every live rule (project + global), each with its activation mode and, for
  // a plugin-sourced one, the owning plugin's name -- see RuleEntry. No
  // create/update/delete: rules stay file-managed (.agents/rules/*.md), same
  // as workflows.
  rules: {
    list(projectPath: string | null): Promise<RuleEntry[]>
  }
  // Memory CRUD + promote (Task 6): Settings > Memory page's list plus
  // add/update/delete of individual bullets and promote-to-rule/skill.
  memory: {
    list(projectPath: string | null): Promise<MemoryList>
    add(scope: MemoryScopeName, text: string, projectPath: string | null): Promise<'ok' | 'full'>
    update(
      scope: MemoryScopeName,
      index: number,
      text: string,
      projectPath: string | null
    ): Promise<void>
    delete(scope: MemoryScopeName, index: number, projectPath: string | null): Promise<void>
    promote(input: MemoryPromoteInput, projectPath: string | null): Promise<void>
  }
  // Plugins (Phase G plugins arc, Task 9): the Settings > Plugins page's
  // installed-list + enable-toggle/uninstall/update, and the browse-catalog /
  // add-marketplace / install-from-URL flow (Task 8's prepareInstall stages a
  // candidate without writing anything real; confirmInstall is the only call
  // that lands it in the live plugins tree). Every write is path-jailed and
  // kebab-name validated main-side (plugins/index.ts, plugins/marketplace.ts).
  plugins: {
    list(projectPath: string | null): Promise<PluginEntry[]>
    catalog(): Promise<MarketplacePlugin[]>
    listMarketplaces(): Promise<string[]>
    addMarketplace(url: string): Promise<void>
    removeMarketplace(url: string): Promise<void>
    prepareInstall(
      source: string,
      marketplaceUrl?: string
    ): Promise<{ manifest: PluginManifest; stagePath: string }>
    confirmInstall(stagePath: string): Promise<void>
    installFromUrl(url: string): Promise<{ manifest: PluginManifest; stagePath: string }>
    setEnabled(
      scope: 'global' | 'project',
      name: string,
      on: boolean,
      projectPath: string | null
    ): Promise<void>
    update(name: string): Promise<PluginUpdateResult>
    uninstall(scope: 'global' | 'project', name: string, projectPath: string | null): Promise<void>
  }
  // Hooks (Phase G hooks arc, Task 9): the Settings > Hooks page's discovered
  // hook list (global always, project/plugin trust-gated) + the per-hook
  // enable/consent toggle, and global-hook authoring (create/update/delete --
  // project/plugin hooks.json files are read-only in-app, design §2
  // decision #3). Every write is path-jailed and kebab-name validated
  // main-side (hooks/authoring.ts, hooks/validate.ts).
  hooks: {
    list(projectPath: string | null): Promise<HookRecord[]>
    setActive(
      scope: 'global' | 'project' | 'plugin',
      source: string,
      name: string,
      on: boolean,
      projectPath: string | null
    ): Promise<void>
    create(input: HookAuthoringInput): Promise<void>
    update(name: string, input: HookAuthoringInput): Promise<void>
    delete(name: string): Promise<void>
  }
  onEvent(cb: (conversationId: string, event: Event) => void): () => void
  onRunStateChange(cb: (conversationId: string, state: RunState) => void): () => void
  onConversationMeta(cb: (meta: ConversationMeta) => void): () => void
}
