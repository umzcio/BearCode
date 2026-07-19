import { hostname, platform, release } from 'os'
import { getSettings } from '../settings'

// Turn the user's profile + global custom instructions (from AppSettings) into
// prompt lines. Pure and side-effect-free: returns [] when nothing is set, so
// the caller can splice it unconditionally. Each part is emitted only when its
// (trimmed) value is non-empty.
export function personalizationBlock(s: {
  profileName?: string
  profileCallMe?: string
  customInstructions?: string
}): string[] {
  const name = (s.profileName ?? '').trim()
  const callMe = (s.profileCallMe ?? '').trim()
  const instructions = (s.customInstructions ?? '').trim()
  const lines: string[] = []
  if (name) lines.push(`The user's name is ${name}.`)
  if (callMe) lines.push(`Address the user as ${callMe}.`)
  if (instructions) {
    lines.push(
      'The user has provided the following custom instructions. Follow them:',
      instructions
    )
  }
  return lines
}

// The main agent's system prompt. createDeepAgent PREPENDS this to Deep Agents'
// own base + filesystem-tool prompts (verified in
// deepagents/dist/langsmith-*.cjs: `new SystemMessage([customSystemPrompt,
// BASE_AGENT_PROMPT])`, with FILESYSTEM_SYSTEM_PROMPT still concatenated by the
// filesystem middleware), so this is additive and takes priority. Its job is to
// make the agent BUILD with its file tools instead of pasting code into chat --
// without it the default prompt lets a chatty model (e.g. GPT) answer a "make a
// website" request by dumping HTML in the reply and never calling write_file.
export function orchestratorSystemPrompt(projectPath: string | null, isPlan = false): string {
  const lines = [
    "You are BearCode, an autonomous coding agent running on the user's own machine.",
    `Host: ${platform()} ${release()} (${hostname()}).`
  ]
  // Fold in the user's profile + global custom instructions, read live from
  // settings, right after the intro and before any task-specific framing.
  const personal = personalizationBlock(getSettings())
  if (personal.length) lines.push('', ...personal)
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
  } else {
    lines.push(
      '',
      'No workspace folder is open for this conversation, so you cannot create or edit files',
      'on disk. If the user asks you to build or modify a project, tell them to open a',
      'project folder first. Otherwise, answer their question directly.'
    )
  }
  // Plan-mode frame (mode-picker design §5): emitted ONLY when the conversation
  // is in Plan mode. The system prompt is assembled per-turn in
  // buildAgentAndContext, so switching INTO plan mode adds this on the next turn
  // automatically. Read-only is ENFORCED at the gate (resolver plan-block); this
  // frame just tells the agent the intended workflow.
  if (isPlan) {
    lines.push(
      '',
      'PLAN MODE (read-only until approved):',
      'The workspace is READ-ONLY right now: run_command and file edits are blocked',
      'until your plan is approved. Work in this order:',
      '- Research first: use ls, glob, grep, and read_file to understand the code before planning.',
      '- Write the plan, then call submit_plan BEFORE attempting to change anything.',
      '- Wait for the outcome: the user will Proceed (approve) or send review comments.',
      '  Do not try to edit files or run commands until then; they will be blocked.',
      '- If review comments come back, revise and call submit_plan again (a new version).',
      '- Keep your todo list current as you work through the approved plan.',
      '- When the implementation is finished, call submit_walkthrough to summarize what changed.'
    )
  }
  lines.push(
    '',
    '- To create a docx, xlsx, or pdf file, call generate_document (never hand-write binary bytes with write_file). If no folder is open, tell the user to open one first instead of pasting file contents.'
  )
  lines.push('', 'Keep any visible reasoning concise. Do not use em dashes in your replies.')
  return lines.join('\n')
}

// Appended to the system prompt ONLY when this turn's request actually
// carries a server-side web-search tool (serverSearchActive in models.ts).
// Two live-diagnosed Grok behaviors this corrects:
//   1. With server search available it still reached for browser_navigate
//      to do plain lookups (slower, needs approval, often denied).
//   2. After each tool round it restated its ENTIRE previous answer, so the
//      final message contained the same answer two or three times.
export function webSearchPromptBlock(): string {
  return [
    '',
    'Web search is enabled for this conversation:',
    '- Your requests carry a built-in server-side web search tool. For looking up',
    '  information on the web, USE IT (just answer; the search runs server-side).',
    '  Do not use browser_* tools or the browser subagent for plain lookups; reserve',
    '  the browser for tasks that genuinely need page interaction (forms, logins,',
    '  screenshots, dynamic apps).',
    '- Write your final answer EXACTLY ONCE. When you continue after a tool result,',
    '  do not restate or rewrite the answer you already produced; continue from where',
    '  you left off, or state only what is new.'
  ].join('\n')
}
