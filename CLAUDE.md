# BearCode — Working Conventions

Instructions for any AI agent (and human) working in this repo. **Read this before adding UI.**
The #1 rule: **do not hand-roll UI that a shared primitive already provides.** New dropdowns,
empty states, form hints, and modals must reuse the primitives below so nothing "goes rogue."

## UI primitives — ALWAYS reuse (never re-implement)

All in `src/renderer/src/components/ui/` and `src/renderer/src/lib/`:

| Need | Use | Never do |
|------|-----|----------|
| Any dropdown / select / menu / popover | **`<Menu>`** (simple lists) or **`<Popover>`** (rich content: search, toggles, help). `Select` is a thin wrapper over `Menu`. | Hand-roll positioning, a native `<select>`, or a bespoke `.menu` with its own `getBoundingClientRect`/click-outside/Esc. |
| Positioning a floating element | **`<Popover>`** (portal + viewport flip + animation + dismiss) via `lib/usePopoverPosition.ts` + `lib/anchorRect.ts` | Copy the zoom-correction math (`document.documentElement.style.zoom`) — it's centralized. |
| Empty / loading / error state | **`<EmptyState title hint?>`**, **`<Loading label?>`**, **`<ErrorCard>`** | A new `*-empty` CSS class, a bare unclassed "Loading…" string, or raw `Error: ${…}` text. |
| A form whose submit can be disabled | **`<FieldHint show>`** + `lib/validators.ts` (`KEBAB_PATTERN`, `isKebabName`, `KEBAB_HINT`) | Silently disable a submit button with no visible reason. |
| Tooltip on an icon-only / non-obvious control | **`<Hint label keys?>`** (`components/Hint.tsx`) — keyboard-accessible | Bare native `title=` on interactive icon buttons. (Don't over-tip labeled controls.) |
| Exit animation for a conditionally-rendered element | **`lib/useAnimatedUnmount`** + `[data-state='closing']` CSS | Let a modal teleport out. (When retaining state for the exit, RESET it after `!mounted` — see the ConflictResolver gotcha in the design docs.) |

**Dropdowns are always custom, app-styled components — never native `<select>`.**

## Motion & animation

- Motion tokens live in `src/renderer/src/styles/tokens.css`: `--ease-out`, `--ease-in-out`,
  `--ease-drawer`, `--dur-press/-fast/-menu/-modal`. **Use the tokens — don't hardcode curves/durations.**
- **Animate `transform` and `opacity` only** (never `width`/`margin`/`top`/`left` — layout thrash).
  No `transition: all`. Never `scale(0)` (use `0.96`).
- **Every movement animation ships a `@media (prefers-reduced-motion: reduce)` fallback** that drops
  the transform but keeps opacity/color.
- Focus: use the `--focus`/`--focus-ring` tokens + `:focus-visible`. Never `outline: none` without a
  `:focus-visible` replacement.
- Click toggles = critically damped (no overshoot); reserve bounce for momentum gestures.
- For motion audits/decisions, the `apple-design` and `improve-animations` skills are installed globally.

## Build & gate

- Stack: Electron (electron-vite) + React 19 + TypeScript (strict) + vitest. macOS.
- **Gate before merge:** `npx tsc --noEmit -p tsconfig.node.json` AND `-p tsconfig.web.json` AND
  `npx vitest run`. Baseline pre-existing errors are **17 node-tc / 2 web-tc** — those are not regressions;
  anything above baseline is.
- **Auto-fix scoped only:** `npx eslint --fix <specific paths>`. **Never `npm run lint -- --fix`** — the
  lint script is `eslint .` and it reformats the whole repo.
- Dev-server hygiene: kill stale `electron-vite`/`electron` before relaunch; after switching branches,
  `rm -rf node_modules/.vite out` (stale cache = black screen). Don't switch branches while dev is live.

## Process

- `planning/` is gitignored — design docs and plans live there and are **never committed**.
- Merge to `main` is the maintainer's decision; live-smoke UI before merging.
- Commit-message last line: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@noreply>`

## Where the details live (gitignored `planning/`)

- UX craft overhaul: `planning/2026-07-12-ux-craft-overhaul-design.md` (+ phase plans) — the full
  rationale, the primitive APIs, and the gotchas each phase's review caught.
- Motion pass: `planning/2026-07-12-motion-polish-plan.md`.
