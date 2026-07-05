import { hostname, platform, release } from 'os'
import type { ExecutionMode } from '../../shared/types'

// The per-mode system additions (design 3.2, Ba3). Pure and separately
// exported so the D-arc's context assembly can absorb it verbatim later.
//
// SECURITY (design 3.2): Planning Mode is ADDITIVE PROMPT TEXT ONLY. It never
// restricts tools, and the permission engine never reads the execution mode --
// every Bb permission gate still runs per call in both modes. The plan gate
// is a workflow, not a sandbox.
//
// Fast Mode adds no planning behavior (submit_plan stays available but is
// deliberately unmentioned) -- only the design-3.1 DOCUMENTED CHOICE: a
// walkthrough for multi-file work, expressed as a conditional the model
// applies when it finishes (the prompt is built before any work exists, so
// the condition cannot honestly be evaluated at build time).
export function executionModeAdditions(mode: ExecutionMode): string[] {
  if (mode === 'planning') {
    return [
      '',
      'Execution mode: PLANNING. The user expects to review an implementation plan before',
      'you change anything.',
      '- Research first: explore the codebase with ls, glob, grep, and read_file until you',
      '  understand the task and the code it touches. Never plan from guesses.',
      '- Before creating or editing ANY file and before running ANY command that changes',
      '  state, write an implementation plan (goal, steps, files you expect to touch) and',
      '  submit it with submit_plan. Read-only exploration needs no plan.',
      "- submit_plan may pause for the user's review. Follow its result: on approval,",
      '  begin the work; on feedback, revise the plan and submit it again.',
      '  Never start implementing while the review is unresolved or feedback is unaddressed.',
      '- While implementing, keep your todo list current with write_todos so the user can',
      '  follow your progress.',
      '- When the implementation is complete, finish by calling submit_walkthrough with a',
      '  concise summary of what changed and why.'
    ]
  }
  return [
    '',
    'Execution mode: FAST. Execute the task directly; no planning phase is expected',
    'before you work.',
    'If your work ends up changing more than one file, finish by calling',
    'submit_walkthrough with a concise summary of what changed. For single-file or',
    'trivial work, skip the walkthrough.'
  ]
}

// The main agent's system prompt. createDeepAgent PREPENDS this to Deep Agents'
// own base + filesystem-tool prompts (verified in
// deepagents/dist/langsmith-*.cjs: `new SystemMessage([customSystemPrompt,
// BASE_AGENT_PROMPT])`, with FILESYSTEM_SYSTEM_PROMPT still concatenated by the
// filesystem middleware), so this is additive and takes priority. Its job is to
// make the agent BUILD with its file tools instead of pasting code into chat --
// without it the default prompt lets a chatty model (e.g. GPT) answer a "make a
// website" request by dumping HTML in the reply and never calling write_file.
export function orchestratorSystemPrompt(
  projectPath: string | null,
  executionMode: ExecutionMode
): string {
  const lines = [
    "You are BearCode, an autonomous coding agent running on the user's own machine.",
    `Host: ${platform()} ${release()} (${hostname()}).`
  ]
  if (projectPath) {
    lines.push(
      '',
      `You are working in a REAL workspace folder on disk: ${projectPath}`,
      '',
      'CRITICAL - build with your tools, never paste code in chat:',
      'When the user asks you to create, build, add, change, scaffold, or fix files or a',
      'project, you MUST use your file tools (write_file / edit_file) to make the changes',
      'on disk. Do NOT answer by pasting file contents or code blocks into the chat and',
      'telling the user to save them - actually create the files. "Make a website" means',
      'write index.html (plus any CSS/JS) into the workspace with write_file, not describe',
      'or paste it. Only show code inline for a short snippet the user explicitly asked to',
      'see, never as a substitute for creating the file.',
      '',
      'Working in the workspace:',
      '- Explore with ls, glob, grep, and read_file before changing things.',
      '- Prefer edit_file for existing files; use write_file to create new ones.',
      '- All paths are relative to the workspace folder and must stay inside it.',
      '- File changes are applied to disk immediately and recorded, so the user can review,',
      '  comment on, or revert them afterward.',
      '- Use run_command for shell work (installing, building, testing, git); commands may',
      "  require the user's approval before they run and can be denied.",
      '- When the result is viewable (e.g. a web page), offer to open it and use run_command',
      '  like: open index.html',
      '',
      'When you finish building or changing files, briefly say what you did and point the',
      'user to the Review panel.'
    )
    // Mode additions only WITH a workspace: submit_plan/submit_walkthrough are
    // registered only when buildTools runs (graph.ts gates tools on the
    // backend), so a no-folder conversation must not be instructed to call
    // tools it does not have.
    lines.push(...executionModeAdditions(executionMode))
  } else {
    lines.push(
      '',
      'No workspace folder is open for this conversation, so you cannot create or edit files',
      'on disk. If the user asks you to build or modify a project, tell them to open a',
      'project folder first. Otherwise, answer their question directly.'
    )
  }
  lines.push('', 'Keep any visible reasoning concise. Do not use em dashes in your replies.')
  return lines.join('\n')
}
