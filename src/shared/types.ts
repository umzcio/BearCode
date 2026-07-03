// The contract shared by main, preload, and renderer.
// Change deliberately and update all three layers together.

export type ToolName =
  'list_dir' | 'read_file' | 'search_files' | 'write_file' | 'edit_file' | 'run_command'

export type ApprovalState = 'auto' | 'pending' | 'approved' | 'denied'

export type RunState = 'running' | 'awaiting-approval' | 'done' | 'error' | 'cancelled'

export type Event =
  | { type: 'user_message'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string; durationMs: number }
  | {
      type: 'tool_call'
      id: string
      tool: ToolName
      input: unknown
      approvalState: ApprovalState
    }
  | {
      type: 'tool_result'
      id: string
      callId: string
      output: string
      exitCode?: number
      durationMs: number
      truncated: boolean
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
  | { type: 'assistant_text'; id: string; text: string }
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

// ---- Settings ----

export interface AppSettings {
  ollamaBaseUrl: string
  autoApproveCommands: boolean
  defaultModelRef: ModelRef | null
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
  keys: {
    set(provider: ProviderId, key: string): Promise<void>
    status(): Promise<Record<ProviderId, boolean>>
  }
  settings: {
    get(): Promise<SettingsInfo>
    set(patch: Partial<AppSettings>): Promise<SettingsInfo>
  }
  conversations: {
    clear(): Promise<void>
  }
  workspace: {
    pick(): Promise<string | null>
  }
  onEvent(cb: (conversationId: string, event: Event) => void): () => void
  onRunStateChange(cb: (conversationId: string, state: RunState) => void): () => void
}
