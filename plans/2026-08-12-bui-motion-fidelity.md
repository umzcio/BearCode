# BUI Motion Fidelity Pass

Stamped at commit `c94b55e` on branch `beautiful-ui-overhaul`. Zach's smoke verdict on the visual
restyle: "not clean and crisp animations and transitions like the beautifului — feels almost the
exact same as bearcode." Root cause: the restyle ported look, not choreography. This plan ports the
motion, extracted verbatim from the Beautiful UI component sources.

## Foundation (ALREADY LANDED — do not redo)

- `styles/tokens.css`: `--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)` (color/hover ONLY),
  `--dur-hover: 100ms`, `--dur-reveal: 300ms`, `--dur-reveal-lg: 400ms`.
- `styles/shared.css`: global `@keyframes fade-in / fade-up / pop-in / stream-in` with
  prefers-reduced-motion transform-free variants. Reference these; NEVER define local duplicates.

## The BUI motion grammar (exact, from their source)

1. **Hover/color feedback**: every interactive row/chip/button gets
   `transition: background-color var(--dur-hover) var(--ease-standard), color var(--dur-hover) var(--ease-standard)`
   (+ border-color/box-shadow when they change). 100ms. Never the strong `--ease-out` for colors.
   Slightly larger surfaces (cards, segmented controls) may use 150ms (`--dur-fast`).
2. **Collapsibles**: wrapper `display: grid; grid-template-rows: 0fr; opacity: 0;
   transition: grid-template-rows var(--dur-reveal) var(--ease-out), opacity var(--dur-reveal) var(--ease-out);`
   open state `grid-template-rows: 1fr; opacity: 1;` inner element `overflow: hidden; min-height: 0;`.
   Large bodies use `--dur-reveal-lg`. Disclosure chevron: `transition: transform 200ms var(--ease-out)`,
   collapsed `rotate(-90deg)`, open `rotate(0)`.
3. **Entrances**: new rows/steps `animation: fade-up var(--dur-reveal) var(--ease-out) both` with
   per-row `animation-delay: calc(var(--i) * 80ms)` staggering (set `--i` inline per row, cap ~6);
   chips/small cards `animation: pop-in 250ms var(--ease-out) both` (stagger 80ms when in a set);
   swapped status badges `animation: fade-in 200ms var(--ease-out) both`.
4. **Streamed text**: each newly appended block `animation: stream-in 420ms cubic-bezier(0.22, 0.61, 0.25, 1) both`.
   Only the incoming block animates — never re-trigger on old content (key by block index/id, or
   apply a class only to the last block while streaming). Filter is paint-only but avoid applying to
   huge blocks: cap at block level, not per-character.
5. **Menus/popovers**: enter `pop-in` character, 160ms `var(--ease-out)`, transform-origin at the
   anchor edge. (Popover/Menu primitives only — one owner.)
6. **Structural movement** (drawers, panes, FLIP) is already right — do NOT retime it.

## Hard rules for executors

- Tokens only; no literal curves/durations except the two BUI constants that have no token:
  `200ms` chevron and `420ms cubic-bezier(0.22, 0.61, 0.25, 1)` stream-in (allowed inline, comment them).
- Animate transform/opacity (+ the sanctioned grid-template-rows collapsible trick and stream-in's
  blur). NO width/height/margin/top transitions. No `transition: all`.
- Every new animation: verify the OS `prefers-reduced-motion` path (shared.css keyframe variants
  cover entrances; collapsibles need `transition-duration: 0.001ms` NOT display:none snapping —
  the app-level `:root[data-motion='reduced']` blanket already handles the in-app setting).
- Behavior unchanged: collapse/expand state logic, streaming logic, tests' semantics. className/
  wrapper additions are expected (grid-rows needs a wrapper).
- Gate your files: `npx eslint <changed>` = 0; related `npx vitest run` green; never delete tests.

## Workstreams (disjoint ownership)

- **W2 transcript**: `components/events/*` (WorkedGroup steps collapse + stagger, ToolStep body
  collapse + chevron + status badge fades + row hover 100ms), `ConversationView.css` (cards fade-up),
  `RunStatusBar.css` (hover only).
- **W3 streaming + markdown**: `lib/markdown.tsx` + its css homes (stream-in on incoming streamed
  block, citation chips pop-in, sources panel grid-rows collapse, code-card copy hover 100ms).
- **W4 primitives + menus**: `styles/shared.css` transitions sweep (menu items, buttons, chips,
  toasts to --dur-hover/--ease-standard), `components/ui/Popover.css` + `.menu` enter = pop-in
  160ms anchored origin, `Select.css`, `Hint.css` (tooltip enter fade-in 150ms).
- **W5 surfaces sweep**: hover retiming (grammar rule 1) + collapsible/entrance opportunities
  (rules 2-3) across `Sidebar/*`, `Composer/* + pickers`, `ArtifactsPane.css`, `ModelsPage/*`,
  `History/`, `ProjectsIndex/ProjectPage`, `Settings/* + ProjectSettings`, `Terminal/*`,
  `Worktree/*`. Retime existing transitions; add entrances ONLY where content appears dynamically
  (search results fade-up stagger, modal body fade-up, table row hover) — no decoration on static pages.

## Verification / feel-check

Full gate (typecheck, eslint changed, vitest run, build). Then live: expand/collapse a Worked
group (smooth 300ms, no snap), run an agent (steps cascade in, badges fade, streamed prose
materializes with the blur), hover any sidebar/menu/table row (instant-feeling 100ms), open menus
(quick pop from anchor). Toggle reduced motion: everything still legible, nothing snaps to
display:none mid-animation.
