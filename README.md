<p align="center">
  <img src="resources/icon.png" alt="BearCode" width="140" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/bearcode-Desktop_Agent_Manager-2544FB?style=for-the-badge&labelColor=0A163F" alt="BearCode" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v1.0-2544FB?style=flat-square" alt="v1.0" />
  <img src="https://img.shields.io/badge/license-MIT-2544FB?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/stack-Electron%20%7C%20React%2019%20%7C%20TypeScript-0A163F?style=flat-square" alt="Stack" />
  <img src="https://img.shields.io/badge/platform-macOS-34d399?style=flat-square" alt="macOS" />
</p>

<p align="center">
  <strong>An open-source, self-hosted agent manager, inspired by Google Antigravity.</strong><br/>
  Point an agent (Claude, GPT, Gemini, OpenRouter, or local Ollama) at a folder and watch it plan,
  run tools, and produce reviewable diffs — with a full agent-loop spine: rules, skills, workflows,
  hooks, plugins, memory, and sandboxing, all on your machine.<br/><br/>
  <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#the-agents-spine">The .agents Spine</a> · <a href="#architecture">Architecture</a>
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
- **Multi-provider model support**: Anthropic, OpenAI, Google, OpenRouter, and local Ollama —
  switch mid-conversation, set per-project defaults, add custom models and context windows
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
- **Full conversation history**, pin/archive, rename, and per-conversation model/effort picking
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
| **Agent runtime** | Vercel AI SDK (`ai`) · LangChain.js · LangGraph.js · `deepagents` |
| **Model providers** | `@ai-sdk/anthropic` · `@ai-sdk/openai` · `@ai-sdk/google` · `@langchain/ollama` · OpenRouter |
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
- API keys for whichever model providers you want (Anthropic, OpenAI, Google, OpenRouter) — or
  Ollama running locally for a fully offline setup

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
