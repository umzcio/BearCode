# Contributing to BearCode

Thanks for considering a contribution. BearCode is an Electron + React 19 + TypeScript (strict)
desktop app, macOS-first, built around a `.agents/` file spine inspired by Google Antigravity.
This doc covers local setup, the conventions the codebase expects, and how to get a change merged.

**Read [CLAUDE.md](CLAUDE.md) before touching any UI.** It's the canonical "use this primitive,
never that" reference (dropdowns, empty states, form hints, motion tokens) — it applies to human
contributors exactly as it does to AI agents working in this repo.

## Local Development Setup

**Prerequisites:**
- macOS (the sandbox layer and traffic-light window chrome are macOS-specific)
- Node.js 20+
- At least one model provider API key (Anthropic, OpenAI, Google, or OpenRouter), or a local
  Ollama install for fully offline development

```bash
git clone https://github.com/umzcio/BearCode.git
cd BearCode
npm install
npm run dev
```

`npm run dev` launches Electron with hot module reload for the renderer. Add your provider key(s)
in **Settings → Providers** on first launch.

### Dev-server hygiene

- Kill any stale `electron-vite`/`electron` process before relaunching — a leftover instance will
  fight the new one for the same port.
- After switching branches, run `rm -rf node_modules/.vite out` — a stale Vite cache after a
  branch switch is the most common cause of a black screen on launch.
- Don't switch git branches while the dev server is running.

## The Gate

Every change must pass, in full, before it's mergeable:

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx vitest run
```

The repo currently carries a small number of pre-existing, known typecheck errors as a baseline
(17 in the node project, 2 in the web project). These are not regressions and not yours to fix
incidentally — just don't add to the count. Anything above baseline on your branch blocks merge.

**Auto-fixing lint issues must be scoped to the files you touched:**

```bash
npx eslint --fix path/to/your/file.ts path/to/another.tsx
```

**Never run `npm run lint -- --fix`.** The underlying lint script is `eslint .` — passing `--fix`
reformats the entire repository, not just your change, and will produce an enormous unrelated diff.

## UI Conventions

BearCode has a shared primitive layer specifically so new UI can't "go rogue." Before writing any
dropdown, menu, popover, empty state, loading state, error state, tooltip, or form with a
disableable submit button, check the table in [CLAUDE.md](CLAUDE.md) — there's almost certainly an
existing component to reuse:

| Need | Use |
|------|-----|
| Dropdown / select / menu / popover | `<Menu>` or `<Popover>` (`src/renderer/src/components/ui/`) |
| Empty / loading / error state | `<EmptyState>`, `<Loading>`, `<ErrorCard>` |
| A form with a conditionally-disabled submit | `<FieldHint>` + `lib/validators.ts` |
| Tooltip on an icon-only control | `<Hint>` (`components/Hint.tsx`) |
| Exit animation for conditionally-rendered UI | `lib/useAnimatedUnmount` |

Dropdowns are always custom, app-styled components — **never** a native `<select>`.

### Motion

- Use the tokens in `src/renderer/src/styles/tokens.css` (`--ease-out`, `--ease-in-out`,
  `--ease-drawer`, `--dur-press/-fast/-menu/-modal`). Don't hardcode a curve or duration.
- Animate only `transform` and `opacity` — never `width`, `margin`, `top`, or `left`, and never
  `transition: all`.
- Every animation that moves something needs a `@media (prefers-reduced-motion: reduce)` fallback
  that drops the transform but keeps opacity/color.
- Never `scale(0)` — use `0.96`. Reserve overshoot/bounce for gestures that carried momentum
  (a flick, a drag release); UI toggles should be critically damped, no bounce.
- Never `outline: none` without a `:focus-visible` replacement using the `--focus`/`--focus-ring`
  tokens.

## Making a Change

1. **Branch off `main`.**
2. **Follow existing patterns.** Look at a sibling file before inventing a new one — the
   `agentsDir`, `mcp`, `plugins`, and `hooks` modules under `src/main/` are good reference points
   for how a new main-process feature is structured (state, IPC handler, tests).
3. **Write tests.** Vitest + Testing Library for renderer components; Vitest for main-process
   logic. New IPC handlers need coverage alongside the existing `src/main/ipc.*.test.ts` files.
4. **Run the gate** (above) before opening a PR.
5. **Live-smoke UI changes.** Automated tests verify correctness, not feel — actually launch
   `npm run dev` and use the feature you changed, including edge cases, before calling it done.
6. **Keep `planning/` out of your diff.** It's gitignored on purpose — design docs and working
   notes live there and are never committed.

## Commit Messages

Standard conventional style is fine (`feat:`, `fix:`, `refactor:`, `test:`, ...). Focus the message
on *why*, not a restatement of the diff.

## Pull Requests

- Describe what changed and why, not just what.
- Note any manual/live-smoke testing you did, especially for UI changes.
- Merges to `main` are a maintainer decision — expect review before merge, particularly for
  anything touching the sandbox, trust model, or agent-loop engine.

## Security

If you find a security issue — anything touching the sandbox escape hatch, the secrets vault, path
jailing under `.agents/`, or the trust/consent model — please report it privately rather than
opening a public issue. Open a GitHub issue marked as a security concern with minimal public
detail, or reach out to the maintainer directly, and a fix will be coordinated before public
disclosure.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](LICENSE).
