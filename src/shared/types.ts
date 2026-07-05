// The contract shared by main, preload, and renderer.
// Change deliberately and update all three layers together.

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

export type ApprovalState = 'auto' | 'pending' | 'approved' | 'denied'

export type PermissionMode = 'accept-edits' | 'auto' | 'plan'

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

export type RunState = 'running' | 'awaiting-approval' | 'done' | 'error' | 'cancelled'

export type Event =
  | { type: 'user_message'; id: string; text: string; createdAt?: number }
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
      projectPath: string | null
    ): Promise<void>
    cancel(conversationId: string): Promise<void>
  }
  models: {
    list(): Promise<ProviderModels[]>
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
  }
  workspace: {
    pick(): Promise<string | null>
  }
  onEvent(cb: (conversationId: string, event: Event) => void): () => void
  onRunStateChange(cb: (conversationId: string, state: RunState) => void): () => void
  onConversationMeta(cb: (meta: ConversationMeta) => void): () => void
}
