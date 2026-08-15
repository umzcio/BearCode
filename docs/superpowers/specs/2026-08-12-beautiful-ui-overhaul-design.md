# Beautiful UI Overhaul — Design

**Date:** 2026-08-12 · **Branch:** `beautiful-ui-overhaul` (big-bang, merge when whole app matches)
**Decision (Zach):** Full aesthetic overhaul, faithful adoption of https://www.beautifului.dev/ (MIT).
The Beautiful UI look becomes BearCode's design language app-wide. The existing theme system
(Dark/Light/System/Custom + extras) survives: BUI's dark palette becomes the new Dark, BUI's light
palette the new Light; custom themes keep overriding colors on top.

Extracted source material (session scratchpad, copy into the repo is NOT needed — reference only):
`/private/tmp/claude-501/-Users-zach-GitHub-BearCode/5d3cfb56-2509-4c2a-8b28-6fcc83a4e67f/scratchpad/`
— `beautifului.css` (their full stylesheet), `bui-src/*.tsx` (all 19 components' original
React/Tailwind source), `beautifului.html` (the rendered page).

## 1. Foundations (tokens.css)

### Fonts
Bundle locally (Electron = offline; no CDN): `@fontsource-variable/inter` and
`@fontsource-variable/jetbrains-mono`, imported once in the renderer entry.
- `--sans: 'Inter Variable', -apple-system, BlinkMacSystemFont, sans-serif`
- `--mono: 'JetBrains Mono Variable', 'SF Mono', ui-monospace, Menlo, monospace`
- `--serif` unchanged (chat serif option keeps working).
Body: 14px stays the base; UI microcopy uses 11.5–13px like BUI (e.g. their code blocks are
11.5px/1.7 mono, labels 12px medium, section text 13px).

### Palette — BUI tokens become the app tokens
New canonical names (BUI vocabulary), defined in `:root` (dark = default, faithful to BUI `.dark`)
and `[data-theme='light']` (BUI light):

| Token | Dark | Light |
|---|---|---|
| `--page` | `#17181a` | `#fafafb` |
| `--canvas` | `#1c1d1f` | `#f1f2f3` |
| `--surface` | `#232427` | `#ffffff` |
| `--inset` | `#1f2022` | `#f7f8f9` |
| `--hover` | `#2a2b2e` | `#f4f5f6` |
| `--hover-2` | `#313236` | `#e7e9eb` |
| `--ink` | `#f2f3f4` | `#1f2124` |
| `--ink-2` | `#a5a8ad` | `#62656b` |
| `--ink-3` | `#6c6f75` | `#9a9da3` |
| `--line` | `#2e3033` | `#ecedef` |
| `--line-strong` | `#3a3c40` | `#e0e2e5` |
| `--field` | `#2b2c2f` | `#f2f2f3` |
| `--stripe` / `--stripe-bg` | `#ffffff0e` / `#1b1c1e` | `#49494913` / `#f5f5f5` |
| `--accent` | `#3d9aff` | `#0285ff` |
| `--accent-ink` | `#7ec0ff` | `#0170dd` |
| `--accent-tint` | `#3d9aff29` | `#e9f3ff` |
| `--green` / `--green-tint` | `#3dbb72` / `#3dbb7224` | `#189a4d` / `#e8f5ed` |
| `--orange` / `--orange-tint` | `#f68f3c` / `#f68f3c24` | `#ef720c` / `#fdf1e5` |
| `--red` / `--red-tint` | `#ee5c61` / `#ee5c6124` | `#e3474c` / `#fcecec` |
| `--tooltip-bg/-fg/-muted/-border` | `#111214` / `#f2f3f4` / `#a5a8ad` / `#2e3033` | `#25272b` / `#f6f7f8` / `#a5a8ad` / `#3a3c40` |

### Shadows (per theme)
Dark: `--shadow-hairline: 0 0 0 1px var(--line)`; `--shadow-btn: 0 0 0 1px var(--line-strong), 0 1px 2px #0000004d`;
`--shadow-card: 0 0 0 1px var(--line), 0 1px 2px #0003, 0 2px 6px #0003`;
`--shadow-raised: 0 0 0 1px var(--line), 0 2px 10px #00000038`;
`--shadow-overlay: 0 0 0 1px var(--line-strong), 0 8px 28px #00000057`;
`--shadow-inset-field: inset 0 1px 2px #0006`.
Light: same names with BUI light values (`#1018280d`-family soft shadows — see beautifului.css).

### Radii
`--radius-chip: 6px`, `--radius-control: 8px`, `--radius-card: 10px`, `--radius-overlay: 12px`.
Legacy `--radius`/`--radius-menu` (12px) remain and now mean "overlay". Cards/panels move to 10px,
buttons/inputs to 8px, chips/badges to 6px.

### Legacy aliases (the migration bridge — REQUIRED)
Old names stay defined as aliases so all 43 CSS files re-skin instantly and custom themes keep
working: `--bg: var(--page)`, `--bg-window: var(--canvas)`, `--bg-sidebar: var(--page)`,
`--bg-raised: var(--surface)`, `--bg-hover: var(--hover)`, `--bg-active: var(--hover-2)`,
`--border: var(--line)`, `--border-soft: var(--line)`, `--text: var(--ink)`,
`--text-mid: var(--ink-2)`, `--text-dim: var(--ink-2)` (NOT ink-3 — contrast audit M-11),
`--accent-strong: var(--accent-ink)`, `--danger: var(--red)`, `--amber: var(--orange)`,
`--wash`/`--wash-strong` keep literal values per theme.
`appearance.ts` custom themes: where it sets inline `--bg/--fg/--accent`-style overrides it must now
also set the corresponding new tokens (`--page/--canvas/--surface/--ink/--accent`) so both
vocabularies follow the custom palette. Component work SHOULD migrate touched rules to the new
names; untouched files keep working through aliases.

### Motion
Keep BearCode's existing motion tokens/durations (already match BUI: our `--ease-out` ≡ their
`--ease-out-strong`). Add `--ease-link: cubic-bezier(.16,1,.3,1)`. All existing motion rules
(transform/opacity only, reduced-motion fallbacks, press feedback) still apply.

## 2. Component design language (applies to every group)

- **Hairline-first depth:** surfaces separate by `--shadow-hairline`/`--shadow-card` on `--surface`
  over `--page`/`--canvas`, not by heavy borders. Inputs sit on `--field` with
  `--shadow-inset-field`. Tables stripe with `--stripe`.
- **Ink hierarchy:** primary text `--ink`, secondary `--ink-2`, tertiary/disabled `--ink-3`.
  Semantic states always pair color + tint (`--green` on `--green-tint`, etc.) as chip/badge fills.
- **Type:** medium-weight (500) 12–13px labels, `tabular-nums` for any number that updates, 11.5px
  JetBrains Mono for code/paths/ids.
- **Translate, don't import:** BUI reference code is React+Tailwind. Re-express it as plain CSS in
  the component's existing `.css` file using the tokens above. NO Tailwind, no inline styles, no
  new CSS variables outside tokens.css.
- **Primitives law (CLAUDE.md) still absolute:** dropdowns via `<Menu>`/`<Popover>`, empty/loading/
  error via `<EmptyState>/<Loading>/<ErrorCard>`, tooltips via `<Hint>`, exit animations via
  `useAnimatedUnmount`. Restyle the primitives once; consumers inherit.
- Focus stays on the `--focus`/`--focus-ring` system (re-point `--focus` at the new `--accent`).
- Accessibility: keep AA contrast — spot-check `--ink-2` on `--inset`/`--surface` pairings; never
  use `--ink-3` for body copy.

## 3. BUI component → BearCode surface map

| BUI reference (bui-src) | BearCode target |
|---|---|
| LoadingState (dot-pattern loader + elapsed) | `Loading` primitive, RunStatusBar working state |
| ThinkingState (Dot.tsx — collapsible reasoning w/ shimmer header) | reasoning/thinking blocks in ConversationView |
| StreamingText + SourceChip (avatar source chips, hover cards) | streamed assistant text + WebSearch citations |
| ApprovalCard (allow/deny w/ command preview) | plan review + tool-approval cards (ArtifactViewer, consent prompts) |
| ToolChips + SpinnerRing (status chips: running/done/error) | tool-call rows in run transcript |
| TaskRows (Section.tsx — status glyph + label + meta rows) | subagent/task rows, worktree run rows |
| ChatComposer / PromptBar | Composer (+ ModePicker/ModelPicker/EffortPicker chips) |
| RecommendationCard / ContextCards / Meter | ContextMeter popover, usage/cost cards |
| DiffTable | review pane diff tables (ArtifactsPane) |
| RecordsTable / FilterTable (Entity.tsx) | ModelsPage tables, HistoryView |
| SidebarNav (Icon.tsx section) | Sidebar |
| SearchList | ⌘K History search |
| InsightCards | Home / ProjectsIndex cards |
| CodeBlock | markdown code blocks (markdown.tsx) |
| ScrubField (FineTuneCard) | numeric fields in Settings (temperature etc.) — optional, only where a numeric field already exists |
| SelectionActions | text-selection action bar in transcript (exists? if not: SKIP — no new features in this overhaul) |

Non-mapping BUI pieces (marketing sections) are ignored. **No new features:** this is a restyle;
component behavior, props, IPC, and tests' semantics don't change.

## 4. Execution groups (disjoint file ownership — one agent each)

0. **Foundation** (first, alone): tokens.css rewrite + aliases, font packages + entry import,
   appearance.ts custom-theme dual-write, App.css/base body styles. Gate: app boots, all tests.
1. **Primitives:** components/ui/* (Popover, Menu, Select, EmptyState, Loading, ErrorCard),
   Hint.css, styles/shared.css, FieldHint. Owns shared.css.
2. **Run transcript:** ConversationView.css/tsx-adjacent styles, thinking/streaming/tool rows,
   RunStatusBar, lib/markdown.tsx code blocks + citations.
3. **Composer & pickers:** Composer.css, SlashMenu.css, ModePicker, ModelPicker, EffortPicker,
   AttachmentPreview, ContextMeter.
4. **Artifacts & review:** ArtifactsPane.css, ArtifactViewer, diff tables, plan feedback UI.
5. **Sidebar & chrome:** Sidebar/*, WindowChrome, brand.css, Home.css.
6. **Pages & tables:** ModelsPage/*, HistoryView, ProjectsIndex, ProjectPage.
7. **Settings:** Settings.css, ProjectSettings.
8. **Utility surfaces:** Terminal (chrome only, not xterm internals — keep xterm.css import!),
   BrowserPane chrome, WorktreeBar, ConflictResolver, ResizeHandle.

Each group agent: read this spec + the mapped bui-src reference files + its target files; restyle;
run `npx eslint <changed>` + related vitest files; fix what it broke. Visual snapshots/pinned CSS
tests may legitimately change — update assertions that pin colors/sizes, never delete tests.

## 5. Verification (after all groups)

- Full gate: `npm run typecheck` (0), `npx eslint` on all changed files (0), `npx vitest run`
  (all), `npm run test:electron:browser` (browser chrome touched), `npm run build`.
- Leftover sweep: grep for retired literals (`#131313`, `#1b1b1b`, `#232323`, `#2c2c2c`,
  `#e7e7e7`, `#4c8dff`, 12px radius on cards/buttons) outside tokens.css — anything found is a
  missed spot; fix to tokens.
- Consistency review agent: every group's diff against §2 rules (no Tailwind, tokens only,
  primitives reused, reduced-motion intact).
- Zach live-smokes the branch before merge (maintainer gate). Merge to main is his call.

## 6. Risks

- **Custom themes:** dual-write in appearance.ts is the one behavioral change; test all 4 extra
  themes + a custom palette in smoke.
- **Contrast:** BUI's `--ink-3` fails AA for text; alias `--text-dim` intentionally maps to ink-2.
- **xterm/monaco:** terminal + editor have their own theming APIs; restyle only their surrounding
  chrome this pass; retheme xterm palette to BUI colors ONLY via its own theme option.
- **Fonts licensing:** Inter + JetBrains Mono are both OFL — clear.
