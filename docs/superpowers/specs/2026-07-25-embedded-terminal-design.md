# Embedded Terminal — Design

**Date:** 2026-07-25
**Status:** Approved, pending implementation plan

## Problem

BearCode's own agent (the LangGraph orchestrator) is one way to get work done in a
project, but Claude Code CLI and Codex CLI are both already installed and usable
tools with their own mature agentic loops, tool sets, and permission UX. There is
currently no way to reach them from inside BearCode — a user has to alt-tab to a
separate terminal application.

Two shapes were considered for bringing them in: (1) proxy their output into
BearCode's own chat UI, the way the existing Hermes/ChuckAI integration proxies an
external HTTP gateway through a sentinel model ref (`runHermes`, `HERMES_MODEL_REF`);
or (2) embed a real terminal panel and let the user run the actual CLI, with its own
native UI and permission prompts, directly. This design is (2) — a real terminal,
not a proxy. It avoids re-implementing two different CLIs' wire protocols and two
different permission models, and gives full-fidelity access to whatever either tool
does next, with no BearCode-side translation layer to keep in sync.

## Goal

An embedded terminal panel, scoped per project folder, spawning a real login shell
in that folder. The user can run `claude`, `codex`, `git`, or anything else exactly
as they would in a standalone terminal app. Multiple tabs per project, shared across
every conversation in that project (not tied to any one chat thread).

**Explicitly not this project's job:** parsing or surfacing the CLI's own tool calls
through BearCode's diff/permission UI, treating the external CLI as a selectable
"model" or Council seat, or persisting/reattaching sessions across an app restart.
These were considered and deferred — see "Out of scope" below.

## Architecture

### Main process

A new `TerminalManager` singleton (`src/main/terminal/manager.ts`), architecturally
parallel to `BrowserManager` (`src/main/browser/manager.ts`) but keyed by
**project path**, not conversation id — a terminal is a workspace resource, shared
across every conversation open on that folder, the way worktrees are project-scoped
rather than conversation-scoped.

- `TerminalManager` holds `Map<projectPath, TerminalSession[]>`.
- Each `TerminalSession` wraps one `node-pty` `IPty`: `{ id, pty, title, projectPath, createdAt, exited: boolean }`.
- Spawn: the user's `$SHELL` env var, falling back to `/bin/zsh -l`; `cwd` is the
  project's folder path (no worktree-cwd resolution for v1 — always the project
  root, not a per-conversation worktree; see Out of scope).
- `node-pty` is a new dependency (none of `node-pty`/`xterm`/`@xterm/xterm` exist in
  `package.json` today). It is a native Node addon and must be rebuilt against
  Electron's ABI — the implementation plan must include a packaged-build
  verification step (native modules that work under `electron-vite dev` can still
  fail to load in a signed/notarized build), not just a dev-mode smoke test.

### IPC bridge

Mirrors the existing `bearcode:browser:*` shape:

- `bearcode:terminal:create(projectPath) -> { id }`
- `bearcode:terminal:write(id, data)`
- `bearcode:terminal:resize(id, cols, rows)`
- `bearcode:terminal:close(id)`
- `bearcode:terminal:list(projectPath) -> TerminalSessionView[]`
- Push event: `bearcode:terminal:data` — `{ id, chunk }`, fired on every pty data
  event, delivered via the same `webContents.send` pattern the Browser feature and
  orchestrator's event sink already use for pushing main→renderer updates.

Preload exposes `window.bearcode.terminal.{create,write,resize,close,list,onData}`,
following the existing `browser: {...}` bridge in `src/preload/index.ts` as the
template.

### Renderer

This is **project-scoped**, not conversation-scoped, so it does not fit the
existing `AuxSelection` slot (`store.ts`'s per-conversation side panel, the slot
Browser occupies today). Instead it extends the top-level `View` union
(`store.ts:80`, currently `{kind:'home'} | {kind:'conversation'; id} | {kind:'history'}`)
with a fourth variant: `{ kind: 'terminal'; path: string }`.

- `TerminalView.tsx` — top-level view component for the `terminal` view kind. Renders
  a tab strip (one tab per open session for `path`) and the active session's
  `TerminalPane`.
- `TerminalPane.tsx` — one `@xterm/xterm` `Terminal` instance + `@xterm/addon-fit`,
  mounted directly in the DOM (unlike `BrowserPane`, which proxies bounds to a
  main-process `WebContentsView` — xterm renders its own canvas/DOM content
  in-renderer, no overlay-view trick needed). Wires `terminal.onData` (pty → xterm
  write) and xterm's `onData` (keystrokes → `terminal.write`) over the IPC bridge.
  A `ResizeObserver` drives `fitAddon.fit()` + `terminal.resize(id, cols, rows)`.
- Theme: xterm's color/font theme reads from BearCode's existing Appearance token
  system rather than a hardcoded palette, so it matches Dark/Light/Custom themes.
- Store additions: `terminalTabs: Record<projectPath, TerminalTabMeta[]>`,
  `activeTerminalTab: Record<projectPath, string | undefined>`, actions
  `openTerminalView(path)`, `createTerminalTab(path)`, `closeTerminalTab(path, id)`,
  `setActiveTerminalTab(path, id)`.

### Entry point

A third `.row-act` icon button on each project's sidebar row
(`src/renderer/src/components/Sidebar/Sidebar.tsx`, ~line 279-296), alongside the
existing gear (Settings) and + (new conversation) buttons, opening the Terminal
view for that folder. Follows the same hover-reveal `.row-act` CSS already in place
(see the "Sidebar `.row-act` gotcha" — these buttons default to `display:none` and
are only revealed on `.convo:hover`; a naive reuse elsewhere renders invisible).

## Lifecycle & scoping

- Multiple tabs per project; shared across all conversations in that folder.
  Switching conversations, or switching away from the project entirely and back,
  does not affect the tab set — `TerminalManager` keeps sessions alive in memory
  for the life of the app.
- No persistence of the tab list and no reattachment across an app restart or
  quit. Every `IPty` is killed when BearCode quits. Relaunching starts with zero
  tabs for every project.
- Closing one tab kills just that pty and removes it from the manager's list for
  that project; other tabs are unaffected.
- Shell exit (user types `exit`, or the process crashes) marks the session
  `exited: true` rather than silently going blank; the tab shows an "exited" state
  with a way to close it or spawn a fresh shell in its place.
- No cap on tab count for v1 (YAGNI).

## Safety model

Default is an **unsandboxed real login shell** — no Seatbelt wrapping, no BearCode
consent/trust gating of what runs inside it. This is a deliberate trade-off, not an
oversight: the entire point is native fidelity — the user sees `claude`'s or
`codex`'s own permission prompts and interacts with them exactly as they would in
Terminal.app. BearCode's existing trust/consent/sandbox system (built for
`run_command`) does not apply to this surface.

The existing Seatbelt machinery (`src/main/orchestrator/sandbox/seatbeltProfile.ts`,
`runner.ts`) is compatible with a login-shell target
(`sandbox-exec -p <profile> /bin/zsh -l` instead of one-shot `-lc <command>`), so an
opt-in "sandboxed terminal" toggle is a natural future addition. **Not built in this
plan** — deferred.

## Testing

- Unit tests for `TerminalManager`: spawn/write/resize/close lifecycle, `cwd`
  resolution from project path, session-list scoping per project (two different
  projects never share a session list), cleanup on `close` and on simulated
  app-quit.
- Unit tests for the IPC handlers and preload bridge shape, matching the existing
  `ipc.*.test.ts` per-feature pattern (e.g. `ipc.browser.test.ts`'s shape, if one
  exists, or `ipc.mcp.test.ts` as the closest analog).
- Renderer: tests for the tab-strip store logic (add/remove/switch-active tab,
  per-project scoping) without rendering real xterm.js — mock the terminal
  instance/IPC bridge, matching how Browser's tests avoid driving a real
  `WebContentsView`.
- No automated test can meaningfully drive a real pty running an interactive CLI.
  Final verification is a live smoke test handed to the user: open the Terminal
  view, run `claude` and `codex`, confirm keystrokes, colored output, resize, and
  scrollback all work — both under `electron-vite dev` and in a packaged build
  (per the native-module risk above).

## Out of scope (this plan)

- Surfacing the external CLI's tool calls (file edits, bash commands) through
  BearCode's own diff/permission UI. The terminal is opaque to BearCode by design.
- Treating Claude Code / Codex as a selectable model or Council/Ursa seat.
- Session persistence or reattachment across an app restart (no tmux-style
  external process manager).
- An opt-in sandboxed-shell mode (Seatbelt-wrapped login shell) — infrastructure
  exists and is compatible, but building the toggle is future work.
- Per-conversation worktree-aware cwd for a terminal tab (always the project root
  for v1, not a specific worktree's directory).
- One-click "Open in Claude Code" launch buttons that auto-run a command in a new
  tab (considered and explicitly not chosen — v1 is a plain shell the user types
  into themselves).
