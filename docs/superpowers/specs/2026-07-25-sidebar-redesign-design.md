# Sidebar Redesign — Design

**Date:** 2026-07-25
**Status:** Approved, pending implementation plan

## Problem

The current sidebar (`src/renderer/src/components/Sidebar/Sidebar.tsx`) has grown
dense and visually flat. Every row — nav items, the ChuckAI section, project
headers, individual conversations — reads at nearly the same visual weight.
Concretely, from live screenshots of the app:

- A "No folder" bucket with 14 conversations renders as an unbroken wall of text
  directly in the sidebar, with no chunking or collapse.
- The selected/active conversation is barely distinguishable (a faint background
  tint is the only cue).
- ChuckAI (the Hermes integration) and Projects share one scroll region with no
  real boundary between them.
- "Conversation History" and "Settings" are full-width text nav rows, spending a
  whole row each on something used rarely relative to picking a project or a
  recent conversation.

## Goal

Redesign the sidebar in the spirit of claude.ai's own desktop sidebar — generous
row height, no per-row hover chrome cluttering every line, a flat `Pinned` /
`Recents` pattern for fast cross-project access, and a real account footer —
adapted for BearCode's actual information architecture, which (unlike claude.ai)
is fundamentally folder-per-project: users switch between named project folders
constantly, so, unlike claude.ai's single generic "Projects" link, each project
keeps its own row.

Validated interactively against a live mockup (five directions were explored and
rejected; the winning direction was built directly off a claude.ai screenshot
supplied as a reference, then iterated to match Claude Code's own chrome-bar and
Home/Code-switcher conventions). This spec captures the mockup's final,
approved state.

## Design

### Chrome bar

Traffic lights, the existing sidebar panel-toggle icon, and a search icon sit
clustered together at the top left, with no `BearCode` wordmark in the chrome bar
(that identity now lives in the footer — see below). The search icon **replaces**
the old "Conversation History" text nav row — same destination
(`openHistory()`), new presentation: an icon-only affordance next to the traffic
lights, matching Claude Code's own chrome bar exactly. Whether this eventually
grows into a real search-first palette (vs. staying a straight shortcut to the
existing History view) is explicitly deferred — see Out of Scope.

### Segmented "Conversations / <Hermes label>" toggle

Directly under the chrome bar, a pill-shaped segmented control switches the
entire sidebar body between two contexts:

- **Conversations** — the project-scoped view (see below).
- **`<hermesLabel>`** — the existing Hermes/ChuckAI integration's own recents
  list. Label text comes from the existing `settings.hermesLabel` (default
  "ChuckAI"); icon comes from the existing `projectIcon(hermesIcon)` lookup
  already used in `Sidebar.tsx`.

This replaces the current always-visible "ChuckAI" section that sits above
Projects. The toggle **only renders when `settings.hermesEnabled` is true** —
this exactly matches the current code's existing gating; when Hermes is
disabled, the sidebar shows the Conversations content directly with no toggle
at all (a single-segment control has nothing to switch, so it's simply absent,
not rendered disabled).

Visually: a `Home | Code`-style pill (like Claude Code's own switcher) — rounded
track, active segment raised with a subtle shadow, inactive segment muted text.

### "+ New Conversation"

One row directly below the toggle, in both segments. In the Conversations
segment it starts a new project-less/home conversation (`goHome()`, matching
today's "New Conversation" nav item). In the ChuckAI segment it calls the
existing `newHermesConversation()` action. Same row, same position, contextual
target.

### Conversations segment body

Three flat sections, in order:

1. **Projects** — one row per folder (today's `groupConversations` folder
   groups), each row: colored/icon chip (reusing `folderSettings`
   color/icon/name lookups already in `Sidebar.tsx`) + project name + a
   conversation count + a trailing chevron. **Clicking a project row navigates
   to a dedicated Project Page** (a new top-level view — see below) instead of
   expanding an inline list. This is the one deliberate structural departure
   from today's accordion-style grouping, and it's what solves the "No folder"
   wall-of-text problem: the sidebar itself never renders more than one row per
   project, no matter how many conversations that project has.
2. **Pinned** — flat list of pinned conversations across every project (today's
   `convo.pinned`), single line each: a small color dot carrying project
   origin + title, no timestamp. No nesting, no headers per project.
3. **Recents** — header with a sort/filter affordance (reusing the existing
   `DisplayOptions` component's sort/group controls conceptually) and a flat,
   cross-project, recency-sorted feed (small dot for project origin, no
   timestamp shown, single line, ellipsis-truncated). A bottom fade-out mask
   signals there's more to scroll. This is the fast path for the "I was just
   working on something, where did it go" case that today requires knowing
   which project it lived in.

### ChuckAI segment body

Just a flat "Recents" list of Hermes conversations (today's `hermesConvoIds`),
same row styling as above, no project dot needed since every row shares the
same origin.

### Project Page (new view)

Opened by clicking any project row. Full-width, replaces the chat pane:

- Header: project icon/color + name + conversation count, and the project's
  actions — Settings, Terminal, New Conversation — promoted to real visible
  buttons (today these are hover-only icons squeezed into the sidebar row;
  `openProjectSettings`, `openTerminalView`, `newConversationInProject` are all
  existing actions, just relocated).
- Body: the full conversation list for that project, day-grouped ("This week",
  "Older", etc.), each row showing title + a real relative timestamp +
  hover-revealed pin/archive actions (reusing the existing `ConvoRowMenu`/
  `setPinned`/`setArchived` pattern). This is where the room-to-breathe problem
  actually gets solved — "No folder" with 14 items gets a proper page instead
  of a crammed sidebar scroll.

### Footer

Simplified to just the user's display name (sourced from a new Settings →
General → Profile → Name field — see Data Model Additions below), with a
trailing chevron. No avatar, no project count, no update-available icon; the
existing app-update indicator stays wherever it currently surfaces (this spec
doesn't relocate it). Clicking the name opens a small dropdown menu, anchored
above the footer row:

- **Settings** — opens the existing settings modal (`openSettings()`).
- **Dark Mode** — a quick toggle switch for the existing dark/light appearance
  setting, so switching modes doesn't require opening the full Settings page.
  Only Dark/Light are exposed here; System/Custom and the other Appearance
  extras remain in the Settings page itself (see Out of Scope).

## Data Model Additions

- A new user-facing "display name" field: Settings → General → Profile → Name.
  Likely a new `AppSettings` field (e.g. `userDisplayName`), free text, no
  validation beyond non-empty-for-display (falls back to some default label if
  unset — exact fallback left to the plan).
- A new top-level view kind for the Project Page, parallel to today's
  `{kind: 'conversation', id}` — e.g. `{kind: 'project', path}` — added to the
  `View` union in `state/store.ts`.

## Out of Scope

- **Search palette behavior.** The chrome-bar search icon is spec'd only as
  "reuses `openHistory()`, relocated." Whether it later grows into a real
  search-first modal/palette is a separate future decision, not this pass.
- **Project Page pagination/virtualization** for projects with very large
  conversation counts — today's largest observed case (14) doesn't need it;
  revisit if usage grows well past that.
- **Reordering or favoriting projects** in the Projects list (drag reorder,
  manual pinning of a project itself) — not part of this pass.
- **Full Appearance settings in the quick account menu.** Only a Dark/Light
  toggle lives there; System/Custom themes and the other Appearance extras stay
  on the Settings page.
- **Relocating the app-update indicator.** Wherever it lives today, it stays —
  this spec only removes it from the (now simplified) footer mockup, it doesn't
  specify a new home for it.
