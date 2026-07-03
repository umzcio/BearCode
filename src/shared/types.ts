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

// Phase 0: hello-world round trip. The full surface from spec 3.1
// (conversations, run, diffs, tools, models, settings, keys, workspace)
// lands with the phases that implement it.
export interface PingResult {
  message: 'pong'
  electron: string
  node: string
  respondedAt: number
}

export interface BearcodeApi {
  ping(): Promise<PingResult>
}
