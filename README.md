<p align="center">
  <img src="resources/icon.png" alt="BearCode" width="140" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/bearcode-Desktop_Agent_Manager-2544FB?style=for-the-badge&labelColor=0A163F" alt="BearCode" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v1.1-2544FB?style=flat-square" alt="v1.1" />
  <img src="https://img.shields.io/badge/license-MIT-2544FB?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/stack-Electron%20%7C%20React%2019%20%7C%20TypeScript-0A163F?style=flat-square" alt="Stack" />
  <img src="https://img.shields.io/badge/platform-macOS-34d399?style=flat-square" alt="macOS" />
</p>

<p align="center">
  <strong>An open-source, self-hosted agent manager, inspired by Google Antigravity.</strong><br/>
  Point an agent (Claude, GPT, Gemini, Grok, Perplexity, OpenRouter, or local Ollama — or let <strong>Ursa</strong>
  route each turn to the best of them) at a folder and watch it plan, run tools, and produce
  reviewable diffs — with a full agent-loop spine: rules, skills, workflows, hooks, plugins,
  memory, and sandboxing, all on your machine.<br/><br/>
  <a href="#quick-start">Quick Start</a> · <a href="#meet-ursa">Meet Ursa</a> · <a href="#features">Features</a> · <a href="#the-agents-spine">The .agents Spine</a> · <a href="#architecture">Architecture</a>
</p>

---

## Why

Agent-manager tools like Google Antigravity are compelling but closed — you don't control the
runtime, can't see how the agent loop actually works, and can't run it against your own
infrastructure. BearCode is what you get if you decide that spine should be yours: same repo, same
model keys, same threat model, fully inspectable.

It takes inspiration from Antigravity's core idea — a **`.agents/` directory** as the durable,
file-based contract between you and the agent — instead of hiding that contract behind a SaaS. Rules,
skills, and workflows live as plain files your agent reads; hooks fire on tool-lifecycle events;
plugins bundle all of the above from a git marketplace; every run is sandboxed with a macOS
Seatbelt profile so a `run_command` call can't touch what it shouldn't. The agent runtime itself is
codenamed **ursa**.

---

## How It Works

```
Open a folder --> Agent reads .agents/ --> You chat / it edits --> Hooks + Sandbox gate every tool call --> Review the diff
```

1. **Open a project folder.** The folder *is* the project — no separate project abstraction, no
   import step. Settings, trust, and `.agents/` config are all keyed to the path.
2. **The agent loads its spine**: project + global rules, available skills, saved workflows,
   registered MCP connectors, and installed plugins, all sourced from `.agents/`.
3. **You converse.** The agent reasons, edits files, runs commands, browses the web, and reports
   back — with live diffs, a review panel, and full conversation history.
4. **Every tool call is gated.** PreToolUse/PostToolUse hooks can observe, block, or inject.
   Shell commands run inside a per-project macOS Seatbelt sandbox unless explicitly trusted.
5. **You review and merge.** Worktree mode isolates risky changes on a branch with a built-in
   merge/conflict resolver; nothing lands until you say so.

---

## Meet Ursa

<p align="center">
  <img src="src/renderer/src/assets/ursa-teddy.svg" alt="Ursa" width="110" />
</p>

<p align="center">
  <strong>Stop picking models. Pick Ursa.</strong>
</p>

**Ursa** is BearCode's cross-provider model router — the top entry in the model picker. Select it
once, and every turn a fast classifier reads your message and routes it to the best model for the
job, *across providers*:

| Role | When your message is… | Ursa routes to |
|------|------------------------|----------------|
| 🏛️ **Architect** | planning, deciding, or designing *before* building | Claude Opus 4.8 |
| 🔨 **Coder** | anything whose deliverable is code or files — any size | GPT-5.6 Sol |
| 🔍 **Reviewer** | review, critique, or verification of existing work | Claude Sonnet 5 |
| 🔎 **Verifier** | fact-checks and current-info lookups against the live web | Sonar Pro |
| ⚡ **Grunt** | quick, routine, mechanical asks | GPT-5.6 Luna |

One conversation can flow through all five — plan with Opus, build with GPT, review with Sonnet,
verify with Sonar — without you touching the picker again.

**How it's built:**

- **Curated, not configurable.** Like the orchestrators in Perplexity and Cursor, the role → model
  assignments are product decisions maintained in code — Settings → Ursa is just an enable toggle
  plus a live check that the required provider API keys are present.
- **Degrades gracefully.** Roles whose provider has no key are skipped; if the classifier itself
  fails, Ursa falls back to the first eligible role instead of erroring your turn.
- **Crash-safe.** The resolved model is persisted per turn, so resuming a conversation never
  re-rolls the routing mid-task.
- **Transparent.** Every assistant turn records which role ran it (hover an assistant message for
  the badge), and the composer picks up a slow-rotating aura in BearCode blue so you always know
  Ursa is at the wheel.
- **Subagents route too.** While Ursa drives the turn, the researcher subagent rides the Reviewer's
  model and the browser subagent rides the Grunt's — no separate picker, same key-availability
  fallback.
- **Pipeline mode.** When your message is really several jobs in one ("plan it, then build it,
  then have someone review it"), the classifier can propose a short sequential pipeline — 2 to 4
  role-tagged steps, each running on its own role's model, one after another. Ursa always asks
  first: you see the full plan before anything runs, and nothing executes until you approve. Say
  no and the turn just falls back to the normal single-role path — no pipeline, no partial work.

**Modes.** Every Ursa conversation is also in one of four modes, picked per-conversation from the
composer (next to the model picker, where the effort selector lives for non-Ursa models):

- **Auto** — the default. Every turn is classified fresh and routed to whichever role fits it best,
  exactly as described above.
- **Code** — locks the turn to the Coder role's model (GPT-5.6 Sol) with no classifier call at all,
  for conversations that are wall-to-wall implementation work.
- **Council** — three models (GPT-5.6 Sol, Gemini 3.1 Pro, Grok 4.5) answer your question
  independently (no agent tools, but each with live server-side web search), anonymously
  peer-review each other's answers, and Fable 5 chairs the panel — reading every answer and review
  to synthesize the final response you see.
- **Deep Research** — a three-step pipeline: Sonar Pro **searches** the live web for facts and
  sources, Claude Opus 4.8 **analyzes** the findings for gaps and follow-ups, and Claude Sonnet 5
  **writes** the final citation-backed report. Requires a Perplexity API key.

---

## See It In Action

<p align="center">
  <a href="https://www.youtube.com/watch?v=Fm-Cl4R_Kvc">
    <img src="https://img.youtube.com/vi/Fm-Cl4R_Kvc/maxresdefault.jpg" alt="BearCode — demo video (YouTube)" width="720" />
  </a>
  <br/>
  <sub><a href="https://www.youtube.com/watch?v=Fm-Cl4R_Kvc">▶ Watch on YouTube</a></sub>
</p>

---

## Features

### Agent Runtime
- **Ursa dynamic model routing**: a cross-provider orchestrator entry in the model picker that
  classifies each turn and routes it to the right model for the job — see
  [Meet Ursa](#meet-ursa)
- **Multi-provider model support**: Anthropic, OpenAI, Google, xAI, Perplexity, OpenRouter, and
  local Ollama — switch mid-conversation, set per-project defaults, add custom models and context
  windows. Includes Grok 4.20 Multi-Agent, where the effort picker maps to the model's parallel
  agent count (up to 16)
- **Web Search toggle**: per-conversation server-side web search (under the effort picker, next to
  Thinking) for Anthropic, OpenAI, and xAI models — Grok gets both `web_search` and `x_search`.
  Off by default (searches are billed per use); Perplexity models are always-on by nature. Results
  land as inline citation chips plus a Sources list on the turn
- **LangGraph.js + Deep Agents orchestrator** running alongside the legacy `ursa` engine behind a
  feature flag, so the runtime can evolve without breaking existing conversations
- **Live diffs and a review panel** for every file the agent touches, plus Monaco-powered code and
  diff viewers
- **Context usage & cost tracking**: real token counts per turn, a per-model cost breakdown, and
  live LiteLLM price sync
- **Voice input**: OpenAI Whisper (cloud) or fully local/offline speech-to-text
- **Sandboxed browser tool**: a `WebContentsView` + Playwright-CDP browser the agent can drive
  directly, gated by the same trust/consent model as everything else

### The `.agents/` Spine
- **Rules**: project + global markdown instructions the agent always has in context
- **Skills**: `SKILL.md`-folder capabilities the agent activates on demand or via `@skill` mention,
  plus a `/learn` flow to capture new skills from a conversation
- **Workflows**: saved, repeatable multi-step procedures
- **Hooks**: `hooks.json`-configured `PreToolUse`/`PostToolUse` command handlers that observe,
  block, or inject at tool-lifecycle boundaries — JSON stdin/stdout contract, global + per-project
  config, trust-gated before anything runs
- **Memory**: durable, file-based agent memory with a secure-by-default load policy
- **Plugins**: git-marketplace bundles that install rules, skills, MCP connectors, and hooks in one
  shot — shallow-clone install, an inert review card before anything activates, folder-URL parsing,
  plugin-provided MCP servers untrusted by default

### Connectors & Integrations
- **MCP connector manager**: discover, enable, and trust Model Context Protocol servers, including
  full OAuth (loopback + system-browser flows)
- **GitHub / Bitbucket integrations**: device-code + PAT for GitHub, app-password for Bitbucket
- **Smithery registry** browsing for one-click MCP install alongside local discovery

### Safety & Trust
- **Per-project Sandbox Mode**: macOS Seatbelt (SBPL) isolation for `run_command` — deny-default,
  environment scrubbing, kernel-enforced, with an explicit `unsandboxed()` escape hatch that
  requires approval
- **Project trust model**: outside-access prompts, a trust banner for anything touching paths
  outside the project, and consent gates on hook execution
- **Secrets vault**: provider keys stored in a vault, never logged, never written to `.agents/`

### Workflow & History
- **Worktree mode**: isolate risky agent work on its own git branch/worktree, with grouping and a
  built-in merge + conflict resolver
- **Full conversation history**, pin/archive, rename, and per-conversation model, effort/mode,
  thinking, and web-search picking
- **Appearance system**: Dark / Light / System / Custom themes, four bundled extras, all
  token-driven

### Craft
- **A shared UI primitive system** (`Popover`, `Menu`, `EmptyState`, `Loading`, `ErrorCard`,
  `FieldHint`, `Hint`) — every dropdown, empty state, and form hint in the app is one of these,
  never hand-rolled. See [CLAUDE.md](CLAUDE.md) for the full "use this, never that" table.
- **A full motion system**: transform/opacity-only animation, `prefers-reduced-motion` fallbacks
  everywhere, FLIP-based sidebar transitions, `@starting-style` enter/exit animations

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Shell** | Electron 39 · electron-vite · electron-builder (macOS-first) |
| **UI** | React 19 · TypeScript strict · Zustand · Monaco Editor |
| **Agent runtime** | LangChain.js · LangGraph.js · `deepagents` (sole engine — the earlier Vercel AI SDK-based loop was retired) |
| **Model providers** | `@langchain/anthropic` · `@langchain/openai` · `@langchain/google-genai` · `@langchain/ollama` · xAI · OpenRouter · Perplexity |
| **Browser tool** | Playwright · Electron `WebContentsView` + CDP |
| **Storage** | better-sqlite3 (conversations, settings, trust) |
| **Documents** | pdf-lib · unpdf · mammoth · docx · exceljs |
| **Sandboxing** | macOS Seatbelt (SBPL) via `sandbox-exec` |
| **Tests** | Vitest · Testing Library |

---

## Architecture

```
                        +-------------------+
                        |  Renderer (React) |
                        |  Zustand store    |
                        +---------+---------+
                                  |  typed IPC (BearcodeApi)
                        +---------+---------+
                        |   Main (Node)     |
                        |  orchestrator /   |
                        |  ursa engine      |
                        +---------+---------+
                                  |
        +---------+---------+---------+---------+---------+
        |         |         |         |         |         |
   +----+---+ +---+----+ +--+-----+ +-+------+ +-+------+ +---+----+
   |agentsDir| |  mcp   | | plugins| | hooks  | | sandbox| | db     |
   | rules/  | | connect| | market | | Pre/   | | Seatbelt| | sqlite|
   | skills/ | | -ors + | | -place | | Post-  | | isolate | | conv/ |
   | workflow| | OAuth  | | bundles| | ToolUse| | run_cmd | | trust |
   +---------+ +--------+ +--------+ +--------+ +---------+ +-------+
```

The renderer never talks to a provider, the filesystem, or a shell directly — every capability is
exposed through the typed `bearcode:*` IPC surface, and every write into `.agents/` or a project
folder is path-jailed in the main process.

---

## Quick Start

**Prerequisites:**
- macOS
- Node.js 20+
- API keys for whichever model providers you want (Anthropic, OpenAI, Google, xAI, Perplexity,
  OpenRouter) — or Ollama running locally for a fully offline setup

**Setup:**

```bash
# Clone
git clone https://github.com/umzcio/BearCode.git
cd BearCode

# Install dependencies
npm install

# Launch in dev mode
npm run dev
```

On first launch, open **Settings → Providers** and add your API key(s), then open a folder to
start your first project.

### Tests & typecheck

```bash
npm run typecheck   # tsc --noEmit, node + web projects
npm test            # Vitest
npm run lint        # eslint --cache .
```

### Building a distributable

```bash
npm run build:mac
```

---

## Project Structure

```
BearCode/
├── src/
│   ├── main/                  # Electron main process (Node)
│   │   ├── agentsDir/         # rules/skills/workflows parsing + trust
│   │   ├── hooks/             # hooks.json loader, runner, PreToolUse/PostToolUse wrap
│   │   ├── mcp/               # MCP connector discovery, OAuth, registry
│   │   ├── plugins/           # git-marketplace install, manifest validation
│   │   ├── skills/            # skill state + enable/disable
│   │   ├── orchestrator/      # LangGraph engine + sandbox + tool implementations
│   │   ├── worktree/          # git worktree mode + merge/conflict resolver
│   │   ├── db/                # sqlite: conversations, trust, project settings
│   │   └── ipc.ts             # the full bearcode:* IPC surface
│   ├── preload/                # typed IPC bridge (BearcodeApi)
│   └── renderer/
│       └── src/
│           ├── components/
│           │   ├── ui/         # shared primitives: Popover, Menu, EmptyState, ...
│           │   ├── Settings/    # Providers, Models, Plugins, Hooks, MCP, Skills, Rules
│           │   ├── ProjectSettings/
│           │   └── Sidebar/, History/, Browser/, Composer/, ...
│           ├── lib/             # anchorRect, usePopoverPosition, validators, useAnimatedUnmount
│           └── styles/tokens.css # motion + design tokens
└── electron-builder.yml
```

---

## Roadmap

Out of scope for v1, on the path for future versions:

- **Sidecars**: long-running background agent processes (deferred in favor of shipping the core
  loop first)
- **Discoverable skills catalog**: a browse/install experience for community skills, beyond the
  current plugin-bundled skills
- **Domain network allowlisting**: a proxy-based allowlist for sandboxed `run_command` network
  access (currently sandbox network policy is coarse-grained)
- **Docker sandbox backend**: an alternative to Seatbelt for non-macOS platforms
- **Per-project connectors & skills UI**: surfacing project-scoped MCP connectors and skills
  directly in Project Settings
- **Windows / Linux support**: the app currently targets macOS only

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, the build/lint/test gate, and PR
guidelines.

## License

[MIT](LICENSE) — open source, self-host freely.

---

<p align="center">
  <em>"The agent should read the same files you do."</em>
</p>
