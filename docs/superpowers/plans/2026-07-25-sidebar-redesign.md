# Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild BearCode's sidebar (`src/renderer/src/components/Sidebar/Sidebar.tsx`) per `docs/superpowers/specs/2026-07-25-sidebar-redesign-design.md`: a chrome-bar search icon replacing the "Conversation History" row, a Conversations/`<hermesLabel>` segmented toggle, flat one-row-per-folder Projects with a new dedicated Project Page (instead of inline-expanding lists), cross-project Pinned/Recents sections, and a name-only footer that opens a Settings/Dark Mode menu.

**Architecture:** No new dependencies. Reuses the existing shared UI primitives throughout (`Popover`, the canonical `.menu`/`.menu-item`/`.menu-divider` CSS in `styles/shared.css`, `EmptyState`, `Hint`, existing motion tokens) rather than introducing new dropdown/animation patterns. One new top-level `View` kind (`'project'`) and one new component (`ProjectPage`) carry the "room to breathe" behavior; the footer becomes its own component (`SidebarFooterMenu`) mirroring the existing `DisplayOptions.tsx` precedent (a `Popover`-anchored trigger button).

**Tech Stack:** Electron (electron-vite) + React 19 + TypeScript (strict) + vitest, matching the rest of the repo.

## Global Constraints

- **Never hand-roll a dropdown.** Every popover in this plan is built directly on the existing `src/renderer/src/components/ui/Popover.tsx` (portal + position + dismiss + animation already handled there — no new positioning or animation code is written in this plan). Simple actionable rows use the canonical `.menu`/`.menu-item`/`.menu-group-label`/`.menu-divider`/`.check` classes already defined in `src/renderer/src/styles/shared.css` — never redeclare their hover/selected/focus states locally.
- **`profileName` already exists** (`AppSettings.profileName`, already wired end-to-end in Settings → General → Profile → Name via `src/renderer/src/components/Settings/pages/GeneralPage.tsx`). No new settings field is added anywhere in this plan — the footer just reads the existing field.
- **Motion:** reduced-motion is handled globally via `:root[data-motion='reduced'] * { transition-duration: 0.001ms !important; ... }` in `styles/tokens.css`. Every transition added in this plan is a plain CSS `transition` (never a bespoke JS animation), so this blanket rule already covers it — no task adds its own `@media (prefers-reduced-motion: reduce)` block. Only `--dur-fast`/`--ease-out` tokens are used for hover/press-style transitions; nothing hardcodes a curve or duration.
- **Focus:** every new interactive element gets a `:focus-visible { outline: none; box-shadow: var(--focus-ring); }` rule — never `outline: none` alone.
- **The "Projects" list is always folder-based**, regardless of the user's `settings.sidebarGroupBy` preference (`project`/`environment`/`status`/`none`). That setting stops affecting the sidebar's own layout in this redesign — it's a known, accepted side effect (not silently hidden: called out again in Task 4), not a regression to fix here.
- **`ConvoRowMenu` only exposes Rename/Delete** — Pin and Archive are separate sibling buttons in every row that needs them (existing convention, preserved, not merged into `ConvoRowMenu`).
- **Dark Mode's quick toggle only flips between exactly `'dark'` and `'light'`** via `setAppearance({ theme })`. `'system'`/`'custom'` remain reachable only from the full Settings page.

---

### Task 1: Store — `project` view kind + `openProjectPage` action

**Files:**
- Modify: `src/renderer/src/state/store.ts:77-81` (the `View` union), `~375` (action interface, right after `openTerminalView`), `~854` (action implementations, right after `openTerminalView`'s impl)
- Test: `src/renderer/src/state/store.projectPage.test.ts`

**Interfaces:**
- Produces: `View` union gains `{ kind: 'project'; path: string | null }` (nullable to represent the "No folder" bucket, matching `ConvoLike.projectPath: string | null` exactly — no magic sentinel string). New action `openProjectPage(path: string | null): void`.

- [ ] **Step 1: Extend the `View` union**

In `src/renderer/src/state/store.ts`, find:

```ts
type View =
  | { kind: 'home' }
  | { kind: 'conversation'; id: string }
  | { kind: 'history' }
  | { kind: 'terminal'; path: string }
```

Replace with:

```ts
type View =
  | { kind: 'home' }
  | { kind: 'conversation'; id: string }
  | { kind: 'history' }
  | { kind: 'terminal'; path: string }
  | { kind: 'project'; path: string | null }
```

- [ ] **Step 2: Add the action to the store interface**

Find (in the store's action interface, right after `openTerminalView`):

```ts
  openTerminalView(path: string): void
```

Add directly after it:

```ts
  openTerminalView(path: string): void
  openProjectPage(path: string | null): void
```

- [ ] **Step 3: Implement the action**

Find the `openTerminalView` implementation:

```ts
    openTerminalView: (path: string) => {
      set({ view: { kind: 'terminal', path }, auxSelection: null })
    },
```

Add directly after it:

```ts
    openProjectPage: (path: string | null) => {
      set({ view: { kind: 'project', path }, auxSelection: null })
    },
```

- [ ] **Step 4: Write the failing test**

Create `src/renderer/src/state/store.projectPage.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from './store'

beforeEach(() => {
  useAppStore.setState({ view: { kind: 'home' } })
})

describe('openProjectPage', () => {
  it('switches to the project view for a real folder path and closes any aux pane', () => {
    useAppStore.setState({ auxSelection: { kind: 'artifact', artifactId: 'a' } })
    useAppStore.getState().openProjectPage('/Users/zach/Projects/ClaudeU-test')
    expect(useAppStore.getState().view).toEqual({
      kind: 'project',
      path: '/Users/zach/Projects/ClaudeU-test'
    })
    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('accepts a null path for the "No folder" bucket', () => {
    useAppStore.getState().openProjectPage(null)
    expect(useAppStore.getState().view).toEqual({ kind: 'project', path: null })
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/state/store.projectPage.test.ts`
Expected: FAIL — `openProjectPage` is not a function (or a TS error if run through `tsc` first).

- [ ] **Step 6: Confirm it passes after Steps 1-3**

Run: `npx vitest run src/renderer/src/state/store.projectPage.test.ts`
Expected: PASS (2/2).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/state/store.ts src/renderer/src/state/store.projectPage.test.ts
git commit -m "feat(sidebar): add project view kind and openProjectPage action"
```

---

### Task 2: `SidebarFooterMenu` component

**Files:**
- Create: `src/renderer/src/components/Sidebar/SidebarFooterMenu.tsx`
- Create: `src/renderer/src/components/Sidebar/SidebarFooterMenu.css`
- Create: `src/renderer/src/components/Sidebar/SidebarFooterMenu.test.tsx`
- Modify: `src/renderer/src/components/icons.tsx` (add `IconMoon`)

**Interfaces:**
- Consumes: `useAppStore` — `settings.profileName`, `settings.theme`, `openSettings(): void`, `setAppearance(patch: Partial<AppSettings>): Promise<void>` (all already exist).
- Produces: `SidebarFooterMenu` — a no-props component (reads the store directly, matching `DisplayOptions.tsx`'s precedent).

- [ ] **Step 1: Add `IconMoon`**

In `src/renderer/src/components/icons.tsx`, append at the end of the file (matching the existing `icon(path, strokeWidth?)` factory used by every other icon):

```tsx
export const IconMoon = icon(<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />)
```

- [ ] **Step 2: Write the failing test**

Create `src/renderer/src/components/Sidebar/SidebarFooterMenu.test.tsx`, mirroring `DisplayOptions.test.tsx`'s harness (stub only `window.bearcode`, since `Popover` attaches real `window` listeners):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { SidebarFooterMenu } from './SidebarFooterMenu'

const settingsSet = vi.fn(() => Promise.resolve({ theme: 'light' }))
const openSettings = vi.fn()

beforeEach(() => {
  vi.stubGlobal('bearcode', { settings: { set: settingsSet } })
  useAppStore.setState({
    settings: { profileName: 'Zach', theme: 'dark' } as never,
    openSettings
  })
  settingsSet.mockClear()
  openSettings.mockClear()
})
afterEach(cleanup)

describe('SidebarFooterMenu', () => {
  it('shows the profile name, falling back to "You" when unset', () => {
    render(<SidebarFooterMenu />)
    expect(screen.getByText('Zach')).toBeTruthy()

    cleanup()
    useAppStore.setState({ settings: { profileName: '', theme: 'dark' } as never })
    render(<SidebarFooterMenu />)
    expect(screen.getByText('You')).toBeTruthy()
  })

  it('opens the menu and calls openSettings when Settings is clicked', () => {
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    fireEvent.click(screen.getByText('Settings'))
    expect(openSettings).toHaveBeenCalled()
  })

  it('Dark Mode toggle reflects current theme and flips it via setAppearance', () => {
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(settingsSet).toHaveBeenCalledWith({ theme: 'light' })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/components/Sidebar/SidebarFooterMenu.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 4: Implement the component**

Create `src/renderer/src/components/Sidebar/SidebarFooterMenu.tsx`:

```tsx
import { useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { Popover } from '../ui/Popover'
import { IconChevronDown, IconMoon, IconSettings } from '../icons'
import './SidebarFooterMenu.css'

export function SidebarFooterMenu(): React.JSX.Element {
  const profileName = useAppStore((s) => s.settings?.profileName)
  const theme = useAppStore((s) => s.settings?.theme ?? 'dark')
  const openSettings = useAppStore((s) => s.openSettings)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isDark = theme === 'dark'

  return (
    <div className="sb-footer">
      <button
        ref={triggerRef}
        type="button"
        className="sb-name-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="name">{profileName || 'You'}</span>
        <IconChevronDown />
      </button>
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="top-start"
      >
        <div className="menu menu--in-popover acct-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              openSettings()
            }}
          >
            <IconSettings />
            <span>Settings</span>
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isDark}
            aria-label="Dark Mode"
            className={'menu-item' + (isDark ? ' selected' : '')}
            onClick={() => void setAppearance({ theme: isDark ? 'light' : 'dark' })}
          >
            <IconMoon />
            <span>Dark Mode</span>
            <span className="check">✓</span>
          </button>
        </div>
      </Popover>
    </div>
  )
}
```

Note: the two menu rows are plain `<button>` elements (native Tab/Enter/Space semantics) rather than `DisplayOptions.tsx`'s hand-rolled roving-tabindex `<div role="option">` listbox — that machinery exists there because it navigates ~13 options across four groups; two independent actions don't need it, and a native button is simpler and equally accessible. Both still use the exact shared `.menu-item`/`.check` classes from `styles/shared.css`, so hover/selected/focus-visible states come for free.

- [ ] **Step 5: Add the CSS**

Create `src/renderer/src/components/Sidebar/SidebarFooterMenu.css`:

```css
.sb-footer {
  position: relative;
  margin-top: auto;
  padding: 6px 8px 10px;
  border-top: 1px solid var(--border-soft);
}
.sb-name-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 9px;
  border-radius: 9px;
  cursor: pointer;
  color: var(--text-mid);
  font-size: 13.5px;
  font-weight: 610;
  background: none;
  border: none;
  text-align: left;
  font-family: inherit;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.sb-name-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.sb-name-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.sb-name-btn .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-name-btn svg {
  width: 13px;
  height: 13px;
  color: var(--text-dim);
  flex-shrink: 0;
  transition: transform var(--dur-fast) var(--ease-out);
}
.sb-name-btn[aria-expanded='true'] svg {
  transform: rotate(180deg);
}
.acct-menu {
  min-width: 200px;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/components/Sidebar/SidebarFooterMenu.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Sidebar/SidebarFooterMenu.tsx \
        src/renderer/src/components/Sidebar/SidebarFooterMenu.css \
        src/renderer/src/components/Sidebar/SidebarFooterMenu.test.tsx \
        src/renderer/src/components/icons.tsx
git commit -m "feat(sidebar): add SidebarFooterMenu (name button + Settings/Dark Mode menu)"
```

---

### Task 3: Chrome bar — search icon replaces "Conversation History"

**Files:**
- Modify: `src/renderer/src/components/Sidebar/Sidebar.tsx:1-45` (imports), `~152-177` (chrome + New Conversation + History)
- Modify: `src/renderer/src/components/Sidebar/Sidebar.css:24-51` (`.chrome`/`.wordmark`)
- Modify: `src/renderer/src/components/Sidebar/Sidebar.test.tsx` (or wherever the existing "Conversation History" row is asserted — grep first, update to assert the search icon instead)

**Interfaces:**
- Consumes: existing `openHistory(): void` (unchanged signature, just relocated to the new trigger).

- [ ] **Step 1: Locate the existing assertion on the History row**

Run: `grep -rn "Conversation History" src/renderer/src/components/Sidebar/`
Update whatever test currently does `fireEvent.click(screen.getByText('Conversation History'))` to instead do `fireEvent.click(screen.getByLabelText('History'))` (the new icon button's `aria-label`). This is a mechanical rename, not new test logic — no new assertions needed since `openHistory`'s behavior is unchanged.

- [ ] **Step 2: Update the chrome bar markup**

In `Sidebar.tsx`, find:

```tsx
      <div className="chrome">
        <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
          <button className="chrome-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
            <IconPanel />
          </button>
        </Hint>
        <span className="wordmark">
          <img src={bearMark} alt="" />
          BearCode
        </span>
      </div>

      <Hint label="New Conversation" keys="⌘N" side="right">
        <button className={'nav-item' + (view.kind === 'home' ? ' selected' : '')} onClick={goHome}>
          <IconPlus />
          New Conversation
        </button>
      </Hint>
      <button
        className={'nav-item' + (view.kind === 'history' ? ' selected' : '')}
        onClick={openHistory}
      >
        <IconHistory />
        Conversation History
      </button>
```

Replace with (the `bearMark` import stays — it's reused by the segmented toggle in Task 4 — but the wordmark and the "Conversation History" row are both gone; "New Conversation" moves down and its wiring is finished in Task 4):

```tsx
      <div className="chrome">
        <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
          <button className="chrome-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
            <IconPanel />
          </button>
        </Hint>
        <Hint label="History" side="bottom">
          <button className="chrome-btn" onClick={openHistory} aria-label="History">
            <IconSearch />
          </button>
        </Hint>
      </div>
```

(`IconHistory` stops being used here — Task 4 still needs it for the Hermes segment icon, so leave the import; `IconSearch` is a new import to add alongside the other icon imports at the top of the file.)

- [ ] **Step 3: Update the import line**

Find:

```tsx
import { IconArchive, IconHistory, IconPanel, IconPin, IconPlus, IconSettings, IconTerminal } from '../icons'
```

Replace with:

```tsx
import {
  IconArchive,
  IconHistory,
  IconPanel,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTerminal
} from '../icons'
```

- [ ] **Step 4: Update `Sidebar.css`**

Find:

```css
.chrome {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 16px 78px;
  -webkit-app-region: drag;
}

.wordmark {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--text-mid);
  padding-right: 4px;
  -webkit-app-region: no-drag;
}
.wordmark img {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
```

Replace with (the traffic-light-clearance padding and drag region are unchanged; the wordmark rules are deleted since there's no wordmark left in the chrome bar):

```css
.chrome {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 16px 78px;
  -webkit-app-region: drag;
}
.chrome .chrome-btn {
  -webkit-app-region: no-drag;
}
```

(`-webkit-app-region: no-drag` on the two `chrome-btn`s is a genuine functional requirement, not styling — without it the traffic-light-drag region set on `.chrome` would swallow clicks on both buttons. This was previously only needed implicitly around the wordmark; verify by clicking both buttons in the live-smoke pass in Task 6.)

- [ ] **Step 5: Run the test and both tsc gates**

Run: `npx vitest run src/renderer/src/components/Sidebar/` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, no new errors above the documented baseline (2 web-tc).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Sidebar/Sidebar.tsx \
        src/renderer/src/components/Sidebar/Sidebar.css \
        src/renderer/src/components/Sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): move History to a chrome-bar search icon, drop the wordmark"
```

---

### Task 4: Conversations/`<hermesLabel>` segmented toggle + flat Projects/Pinned/Recents body

This is the largest task: it replaces the entire body of `Sidebar.tsx` between the chrome bar (Task 3) and the footer (Task 2) with the segmented toggle, the "+ New" row, and the two segment bodies.

**Files:**
- Modify: `src/renderer/src/components/Sidebar/Sidebar.tsx` (body + imports)
- Modify: `src/renderer/src/components/Sidebar/Sidebar.css` (replace the old accordion/`.convo`/`.proj-*` rules with the new flat-row rules)
- Modify: `src/renderer/src/components/Sidebar/Sidebar.test.tsx` (update/add tests for the toggle and the new flat rows — see Step 7)

**Interfaces:**
- Consumes: `groupConversations` (unchanged signature, from `./grouping`), `DisplayOptions` (unchanged, just relocated), `EmptyState`, `folderSettings`, `projectIcon`, `bearMark` (all already imported), plus `openProjectPage(path: string | null)` from Task 1 and `SidebarFooterMenu` from Task 2.
- Produces: nothing new consumed by later tasks except `openProjectPage`, which Task 5's `ProjectPage` is the destination of — Task 5 doesn't touch `Sidebar.tsx` again.

- [ ] **Step 1: Add the new imports**

Add to the top of `Sidebar.tsx`, alongside the existing imports:

```tsx
import { useMemo, useRef, useState, useLayoutEffect } from 'react'
```

(`useState` is new; the rest already exist — just add `useState` to the existing `react` import line.) Also add:

```tsx
import { IconChevronRight } from '../icons'
import { SidebarFooterMenu } from './SidebarFooterMenu'
```

(fold `IconChevronRight` into the existing multi-icon import from Task 3 rather than a separate line).

- [ ] **Step 2: Replace the `groups` memo with a folder-only `projectGroups` memo, and add `pinnedIds`/`recentIds`**

Find:

```tsx
  const groups = useMemo(
    () => groupConversations(projectConvoOrder, conversations, { groupBy, sort, showArchived }),
    [projectConvoOrder, conversations, groupBy, sort, showArchived]
  )
```

Replace with:

```tsx
  // The Projects list is always folder-based in this design (see plan's
  // Global Constraints) -- `groupBy` no longer changes what the sidebar
  // itself renders, only `sort`/`showArchived` do.
  const projectGroups = useMemo(
    () => groupConversations(projectConvoOrder, conversations, { groupBy: 'project', sort, showArchived }),
    [projectConvoOrder, conversations, sort, showArchived]
  )

  const RECENTS_LIMIT = 20

  const pinnedIds = useMemo(
    () =>
      projectConvoOrder
        .filter((id) => {
          const c = conversations[id]
          return c != null && c.pinned && (showArchived || !c.archived)
        })
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0)),
    [projectConvoOrder, conversations, showArchived]
  )

  const recentIds = useMemo(
    () =>
      projectConvoOrder
        .filter((id) => {
          const c = conversations[id]
          return c != null && !c.pinned && (showArchived || !c.archived)
        })
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0))
        .slice(0, RECENTS_LIMIT),
    [projectConvoOrder, conversations, showArchived]
  )
```

`groupBy` (from `useAppStore((s) => s.settings?.sidebarGroupBy ?? 'project')`, a few lines above) is now unused in this file except as dead weight — leave the line in place; removing the setting itself is out of scope for this plan (see spec's Out of Scope).

- [ ] **Step 3: Add the segment-mode state and `openProjectPage`/`openSettings` reads**

Find:

```tsx
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const openTerminalView = useAppStore((s) => s.openTerminalView)
```

Add directly after:

```tsx
  const openProjectPage = useAppStore((s) => s.openProjectPage)
  const [mode, setMode] = useState<'conversations' | 'hermes'>('conversations')
```

- [ ] **Step 4: Replace the JSX from the (now-relocated) "New Conversation" row through the end of the "Projects" scroll region**

Find everything from:

```tsx
      {hermesEnabled ? (
        <>
          <div className="projects-head">
```

... through the closing of the `.projects-scroll` div, i.e. all the way to (and including) this line:

```tsx
      </div>

      <div className="sidebar-footer">
```

Replace that entire span with:

```tsx
      {hermesEnabled ? (
        <div className="seg-toggle">
          <button
            type="button"
            className={mode === 'conversations' ? 'active' : ''}
            onClick={() => setMode('conversations')}
          >
            <img src={bearMark} alt="" />
            Conversations
          </button>
          <button
            type="button"
            className={mode === 'hermes' ? 'active' : ''}
            onClick={() => setMode('hermes')}
          >
            <IconHistory size={13} />
            {hermesLabel || 'Hermes'}
          </button>
        </div>
      ) : null}

      <Hint label="New Conversation" keys="⌘N" side="right">
        <button
          className={'nav-item' + (view.kind === 'home' ? ' selected' : '')}
          onClick={() => (mode === 'hermes' && hermesEnabled ? void newHermesConversation() : goHome())}
        >
          <IconPlus />
          New Conversation
        </button>
      </Hint>

      {mode === 'hermes' && hermesEnabled ? (
        <div className="sb-recents">
          <div className="sb-label">Recents</div>
          {hermesConvoIds.length === 0 ? (
            <div className="sidebar-empty">
              <EmptyState title="No Hermes conversations yet" />
            </div>
          ) : (
            hermesConvoIds.map((id) => {
              const convo = conversations[id]
              if (!convo) return null
              const selected = view.kind === 'conversation' && view.id === id
              return (
                <button
                  type="button"
                  key={id}
                  className={'sb-flatrow' + (selected ? ' selected' : '')}
                  onClick={() => openConvo(id)}
                >
                  <span className="name">{convo.title}</span>
                </button>
              )
            })
          )}
        </div>
      ) : (
        <>
          <div className="sb-label">Projects</div>
          {projectGroups.length === 0 ? (
            <div className="sidebar-empty">
              <EmptyState title="No conversations yet" />
            </div>
          ) : (
            projectGroups.map((group) => {
              const path = group.kind === 'folder' ? group.path : null
              const fp = path ? folderSettings.find((f) => f.path === path) : undefined
              const Icon = projectIcon(fp?.icon)
              const label = path ? (fp?.name ?? group.label) : group.label
              return (
                <button
                  type="button"
                  key={path ?? 'none'}
                  className="sb-projrow"
                  onClick={() => openProjectPage(path)}
                >
                  <span
                    className="chip"
                    style={fp?.color ? { background: fp.color + '2e', color: fp.color } : undefined}
                  >
                    <Icon size={11} />
                  </span>
                  <span className="name">{label}</span>
                  <span className="cnt">{group.convoIds.length}</span>
                  <IconChevronRight />
                </button>
              )
            })
          )}

          {pinnedIds.length > 0 ? (
            <>
              <div className="sb-label">Pinned</div>
              {pinnedIds.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                const fp = convo.projectPath
                  ? folderSettings.find((f) => f.path === convo.projectPath)
                  : undefined
                const selected = view.kind === 'conversation' && view.id === id
                return (
                  <button
                    type="button"
                    key={id}
                    className={'sb-flatrow' + (selected ? ' selected' : '')}
                    onClick={() => openConvo(id)}
                  >
                    <span className="dot" style={{ background: fp?.color ?? 'var(--text-dim)' }} />
                    <span className="name">{convo.title}</span>
                  </button>
                )
              })}
            </>
          ) : null}

          <div className="sb-recents">
            <div className="sb-label">
              Recents
              <DisplayOptions />
            </div>
            {recentIds.length === 0 ? (
              <div className="sidebar-empty">
                <EmptyState title="No conversations yet" />
              </div>
            ) : (
              recentIds.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                const fp = convo.projectPath
                  ? folderSettings.find((f) => f.path === convo.projectPath)
                  : undefined
                const selected = view.kind === 'conversation' && view.id === id
                return (
                  <button
                    type="button"
                    key={id}
                    className={'sb-flatrow' + (selected ? ' selected' : '')}
                    onClick={() => openConvo(id)}
                  >
                    <span className="dot" style={{ background: fp?.color ?? 'var(--text-dim)' }} />
                    <span className="name">{convo.title}</span>
                  </button>
                )
              })
            )}
          </div>
        </>
      )}

      <SidebarFooterMenu />
```

- [ ] **Step 5: Delete now-unreachable code**

`hermesIcon` (`useAppStore((s) => s.settings?.hermesIcon)`) is no longer read anywhere in this file (the segment toggle's Hermes icon is now `IconHistory`, matching the History icon already used elsewhere for a list-of-conversations affordance, rather than the customizable per-Hermes icon) — remove the `const hermesIcon = ...` line and its import-time usage. `projectIcon` is still used (for folder icons), so its import stays.

Run: `grep -n "hermesIcon" src/renderer/src/components/Sidebar/Sidebar.tsx` — confirm no remaining references before deleting the line.

- [ ] **Step 6: Replace the old row/group CSS in `Sidebar.css` with the new flat-row CSS**

Find and delete these rule blocks (all now dead — no longer rendered): `.projects-head` and its two nested selectors, `.projects-scroll`, `.hermes-scroll`, `.proj-group`, `.proj-label` and its two nested selectors, `.convo` and every nested/adjacent selector through `.proj-actions` and its `:hover` rule (i.e. everything from `.projects-scroll {` through the file's final `.proj-group:hover .proj-actions .row-act { display: flex; }` rule). `.sidebar-empty` and `.sidebar-footer` stay (still used) — `.sidebar-footer`'s rule is superseded by `SidebarFooterMenu.css`'s own `.sb-footer` rule from Task 2, so delete the duplicate here too:

```css
.sidebar-footer {
  margin-top: auto;
  padding-top: 10px;
}
```

Add in its place:

```css
.seg-toggle {
  display: flex;
  background: var(--bg-active);
  border-radius: 10px;
  padding: 3px;
  margin: 8px 6px 10px;
}
.seg-toggle button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 0;
  border-radius: 8px;
  border: none;
  background: none;
  font-size: 12.5px;
  font-weight: 560;
  color: var(--text-dim);
  cursor: pointer;
  font-family: inherit;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.seg-toggle button:hover {
  color: var(--text-mid);
}
.seg-toggle button.active {
  background: var(--bg-raised);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
}
.seg-toggle button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.seg-toggle button svg,
.seg-toggle button img {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.sb-label {
  display: flex;
  align-items: center;
  padding: 14px 10px 6px;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.sb-label .display-options {
  margin-left: auto;
}

.sb-projrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  border: none;
  background: none;
  color: var(--text-mid);
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.sb-projrow:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.sb-projrow:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.sb-projrow .chip {
  width: 18px;
  height: 18px;
  border-radius: 6px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-active);
  color: var(--text-dim);
}
.sb-projrow .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-projrow .cnt {
  color: var(--text-dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.sb-projrow svg:last-child {
  width: 13px;
  height: 13px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.sb-flatrow {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 9px;
  border: none;
  background: none;
  color: var(--text-mid);
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.sb-flatrow:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.sb-flatrow:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.sb-flatrow.selected {
  background: var(--bg-active);
  color: var(--text);
}
.sb-flatrow .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}
.sb-flatrow .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-recents {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
```

(No bottom fade-mask overlay is included here — the mockup's `::after` gradient was purely decorative scroll affordance; `overflow-y: auto` on `.sb-recents` already communicates scrollability via the native scrollbar, and a gradient mask over real, hover-interactive rows would visually mute the last couple of rows for no functional gain. Flagged for the final review in case this reads as a regression from the approved mockup.)

- [ ] **Step 7: Update `Sidebar.test.tsx`**

Run: `grep -n "ChuckAI\|projects-head\|proj-group\|hermesConvoIds\|Hermes" src/renderer/src/components/Sidebar/Sidebar.test.tsx` to find every assertion touching the old ChuckAI section or accordion rendering, and update each to match the new markup (e.g. an assertion that clicked a nested conversation row inside a project group must become an assertion that clicks a `sb-projrow` and checks `openProjectPage` was called with that project's path — mirroring the exact "assert the action was called" convention already used elsewhere in this file, e.g. `expect(useAppStore.getState().openConvo).toHaveBeenCalledWith('h1')`). Add one new test for the segmented toggle:

```tsx
it('the Conversations/Hermes toggle switches which list renders', () => {
  useAppStore.setState({
    settings: { hermesEnabled: true, hermesLabel: 'ChuckAI' } as never
    // ...whatever other fields this file's existing setup already provides
  })
  render(<Sidebar />)
  expect(screen.getByText('ChuckAI')).toBeTruthy()
  fireEvent.click(screen.getByText('ChuckAI'))
  // whatever this file's existing fixture uses as a Hermes-only conversation
  // title should now be visible, and a known project-only title should not
})
```

(Adapt field names/fixture data to whatever `Sidebar.test.tsx` already sets up elsewhere in the file — don't invent new fixture shapes.)

- [ ] **Step 8: Run the full test file and both tsc gates**

Run: `npx vitest run src/renderer/src/components/Sidebar/` then `npx tsc --noEmit -p tsconfig.web.json`
Expected: PASS, no new errors above baseline.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/Sidebar/Sidebar.tsx \
        src/renderer/src/components/Sidebar/Sidebar.css \
        src/renderer/src/components/Sidebar/Sidebar.test.tsx
git commit -m "feat(sidebar): Conversations/Hermes segmented toggle + flat Projects/Pinned/Recents"
```

---

### Task 5: `ProjectPage` — the dedicated project view

**Files:**
- Create: `src/renderer/src/components/ProjectPage/ProjectPage.tsx`
- Create: `src/renderer/src/components/ProjectPage/ProjectPage.css`
- Create: `src/renderer/src/components/ProjectPage/ProjectPage.test.tsx`
- Modify: `src/renderer/src/App.tsx` (add the `'project'` view case)

**Interfaces:**
- Consumes: `openProjectSettings(path: string)`, `openTerminalView(path: string)`, `newConversationInProject(path: string): Promise<void>`, `setPinned`, `setArchived`, `openConvo`, `folderSettings`, `projectIcon`, `ConvoRowMenu`, `EmptyState`, `relativeAge` (all already exist, all imported the same way `Sidebar.tsx` imports them).
- Produces: `ProjectPage({ path }: { path: string | null })` — the component `App.tsx` renders for `view.kind === 'project'`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/ProjectPage/ProjectPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ProjectPage } from './ProjectPage'

const openProjectSettings = vi.fn()
const openTerminalView = vi.fn()
const newConversationInProject = vi.fn(() => Promise.resolve())
const openConvo = vi.fn()
const setPinned = vi.fn()
const setArchived = vi.fn()

beforeEach(() => {
  useAppStore.setState({
    conversations: {
      a: {
        id: 'a',
        projectPath: '/proj',
        projectLabel: 'proj',
        title: 'First chat',
        updatedAt: Date.now(),
        createdAt: Date.now(),
        pinned: false,
        archived: false,
        runState: 'idle',
        environment: 'local',
        worktrees: []
      }
    } as never,
    convoOrder: ['a'],
    folderSettings: [],
    view: { kind: 'project', path: '/proj' },
    openProjectSettings,
    openTerminalView,
    newConversationInProject,
    openConvo,
    setPinned,
    setArchived
  } as never)
})
afterEach(cleanup)

describe('ProjectPage', () => {
  it('shows the project name, conversation count, and its conversations', () => {
    render(<ProjectPage path="/proj" />)
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('1 conversation')).toBeTruthy()
    expect(screen.getByText('First chat')).toBeTruthy()
  })

  it('wires the Settings/Terminal/New buttons to their store actions', () => {
    render(<ProjectPage path="/proj" />)
    fireEvent.click(screen.getByText('Settings'))
    expect(openProjectSettings).toHaveBeenCalledWith('/proj')
    fireEvent.click(screen.getByText('Terminal'))
    expect(openTerminalView).toHaveBeenCalledWith('/proj')
    fireEvent.click(screen.getByText('New'))
    expect(newConversationInProject).toHaveBeenCalledWith('/proj')
  })

  it('opening a conversation row calls openConvo', () => {
    render(<ProjectPage path="/proj" />)
    fireEvent.click(screen.getByText('First chat'))
    expect(openConvo).toHaveBeenCalledWith('a')
  })

  it('Pin and Archive buttons call their store actions without opening the conversation', () => {
    render(<ProjectPage path="/proj" />)
    fireEvent.click(screen.getByLabelText('Pin'))
    expect(setPinned).toHaveBeenCalledWith('a', true)
    fireEvent.click(screen.getByLabelText('Archive'))
    expect(setArchived).toHaveBeenCalledWith('a', true)
    expect(openConvo).not.toHaveBeenCalled()
  })

  it('the "No folder" bucket (null path) has no Settings/Terminal buttons', () => {
    useAppStore.setState({
      conversations: {
        b: {
          id: 'b',
          projectPath: null,
          projectLabel: 'No folder',
          title: 'Loose chat',
          updatedAt: Date.now(),
          createdAt: Date.now(),
          pinned: false,
          archived: false,
          runState: 'idle',
          environment: 'local',
          worktrees: []
        }
      } as never,
      convoOrder: ['b']
    })
    render(<ProjectPage path={null} />)
    expect(screen.queryByText('Settings')).toBeNull()
    expect(screen.queryByText('Terminal')).toBeNull()
    expect(screen.getByText('New')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/components/ProjectPage/ProjectPage.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the component**

Create `src/renderer/src/components/ProjectPage/ProjectPage.tsx`:

```tsx
import { useMemo } from 'react'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { EmptyState } from '../ui/EmptyState'
import { ConvoRowMenu } from '../Sidebar/ConvoRowMenu'
import { IconArchive, IconFolder, IconPin, IconPlus, IconSettings, IconTerminal } from '../icons'
import { projectIcon } from '../ProjectSettings/projectIcons'
import './ProjectPage.css'

function dayBucket(updatedAt: number, now: number): 'Today' | 'This week' | 'Older' {
  const days = Math.floor((now - updatedAt) / 86_400_000)
  if (days < 1) return 'Today'
  if (days < 7) return 'This week'
  return 'Older'
}

export function ProjectPage({ path }: { path: string | null }): React.JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const folderSettings = useAppStore((s) => s.folderSettings)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const openTerminalView = useAppStore((s) => s.openTerminalView)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const openConvo = useAppStore((s) => s.openConvo)
  const setPinned = useAppStore((s) => s.setPinned)
  const setArchived = useAppStore((s) => s.setArchived)

  const fp = path ? folderSettings.find((f) => f.path === path) : undefined
  const Icon = path ? projectIcon(fp?.icon) : IconFolder
  const label = path ? (fp?.name ?? path.split('/').pop() ?? path) : 'No folder'

  const ids = useMemo(
    () =>
      convoOrder
        .filter((id) => conversations[id]?.projectPath === path)
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0)),
    [convoOrder, conversations, path]
  )

  const now = Date.now()
  const buckets: { label: string; ids: string[] }[] = []
  for (const label of ['Today', 'This week', 'Older'] as const) {
    const bucketIds = ids.filter((id) => dayBucket(conversations[id]?.updatedAt ?? 0, now) === label)
    if (bucketIds.length > 0) buckets.push({ label, ids: bucketIds })
  }

  return (
    <div className="project-page">
      <div className="pp-head">
        <span className="pp-icon">
          <Icon size={17} />
        </span>
        <div className="pp-title">
          <h3>{label}</h3>
          <div className="pp-meta">
            {ids.length} conversation{ids.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="pp-actions">
          {path ? (
            <button type="button" className="pp-btn" onClick={() => openProjectSettings(path)}>
              <IconSettings size={13} />
              Settings
            </button>
          ) : null}
          {path ? (
            <button type="button" className="pp-btn" onClick={() => openTerminalView(path)}>
              <IconTerminal size={13} />
              Terminal
            </button>
          ) : null}
          <button
            type="button"
            className="pp-btn primary"
            onClick={() => (path ? void newConversationInProject(path) : undefined)}
          >
            <IconPlus size={13} />
            New
          </button>
        </div>
      </div>
      <div className="pp-list">
        {ids.length === 0 ? (
          <EmptyState title="No conversations yet" />
        ) : (
          buckets.map((bucket) => (
            <div key={bucket.label}>
              <div className="pp-daylabel">{bucket.label}</div>
              {bucket.ids.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                return (
                  <div
                    key={id}
                    className="pp-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => openConvo(id)}
                    onKeyDown={(e) => {
                      // Ignore keys that originated on a nested action button
                      // (Pin/Archive/⋮) -- only the row's own focus target
                      // should open the conversation. Mirrors Sidebar.tsx's
                      // existing conversation-row convention exactly.
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openConvo(id)
                      }
                    }}
                  >
                    <span className="name">{convo.title}</span>
                    <span className="age">{relativeAge(convo.updatedAt)}</span>
                    <span className="pp-rowact">
                      <button
                        type="button"
                        className={'row-act' + (convo.pinned ? ' active' : '')}
                        aria-label={convo.pinned ? 'Unpin' : 'Pin'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPinned(id, !convo.pinned)
                        }}
                      >
                        <IconPin size={13} />
                      </button>
                      <button
                        type="button"
                        className={'row-act' + (convo.archived ? ' active' : '')}
                        aria-label={convo.archived ? 'Unarchive' : 'Archive'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setArchived(id, !convo.archived)
                        }}
                      >
                        <IconArchive size={13} />
                      </button>
                      <ConvoRowMenu convoId={id} title={convo.title} />
                    </span>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
```

Notes on deliberate scope decisions inline with the spec:
- Pin AND Archive are both wired (full parity with the per-row actions `Sidebar.tsx` had before Task 4's rewrite) — the spec's Project Page description only named "pin/archive hover actions" explicitly for the page body, so both are included, not just Pin.
- The whole row (not just the title) is the click target, using the exact `role="button"`/`tabIndex={0}`/`onKeyDown` convention `Sidebar.tsx` used for its own conversation rows (ignoring keys that originate on a nested action button via `e.target !== e.currentTarget`), so keyboard and screen-reader behavior matches the rest of the app rather than introducing a new, narrower click target.

- [ ] **Step 4: Add the CSS**

Create `src/renderer/src/components/ProjectPage/ProjectPage.css`:

```css
.project-page {
  flex: 1;
  min-width: 0;
  background: var(--bg-window);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.pp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 22px 28px 18px;
  border-bottom: 1px solid var(--border-soft);
}
.pp-icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--wash);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  flex-shrink: 0;
}
.pp-title {
  flex: 1;
  min-width: 0;
}
.pp-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp-title .pp-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}
.pp-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.pp-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-mid);
  font-size: 12.5px;
  background: var(--bg-raised);
  cursor: pointer;
  font-family: inherit;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.pp-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.pp-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.pp-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.pp-list {
  padding: 8px 16px 24px;
}
.pp-daylabel {
  padding: 14px 12px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  font-weight: 650;
}
.pp-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 9px;
}
.pp-row:hover {
  background: var(--bg-hover);
}
.pp-row .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  color: var(--text-mid);
  cursor: pointer;
}
.pp-row:hover .name {
  color: var(--text);
}
.pp-row .age {
  color: var(--text-dim);
  font-size: 12px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.pp-rowact {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.pp-row:hover .pp-rowact {
  opacity: 1;
}
```

(`.row-act` on the Pin button reuses `Sidebar.css`'s existing `.row-act`/`.row-act.active` rules — no redeclaration needed here, same as `ConvoRowMenu.css` already does.)

- [ ] **Step 5: Wire it into `App.tsx`**

Find:

```tsx
  {view.kind === 'terminal' ? <TerminalView path={view.path} /> : null}
```

Add directly after:

```tsx
  {view.kind === 'terminal' ? <TerminalView path={view.path} /> : null}
  {view.kind === 'project' ? <ProjectPage path={view.path} /> : null}
```

And add the import alongside `TerminalView`'s:

```tsx
import { ProjectPage } from './components/ProjectPage/ProjectPage'
```

Also update the `key` expression a few lines above (currently `view.kind === 'conversation' && convo ? \`conversation:${convo.id}\` : view.kind`) so switching between two different projects' pages actually remounts (otherwise React reuses the same `ProjectPage` instance across path changes since `view.kind` alone doesn't change):

```tsx
key={
  view.kind === 'conversation' && convo
    ? `conversation:${convo.id}`
    : view.kind === 'project'
      ? `project:${view.path ?? 'none'}`
      : view.kind
}
```

- [ ] **Step 6: Run the test and both tsc gates**

Run: `npx vitest run src/renderer/src/components/ProjectPage/` then both `npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`
Expected: PASS (4/4), no new errors above baseline.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ProjectPage/ src/renderer/src/App.tsx
git commit -m "feat(sidebar): add ProjectPage, wire project view into App.tsx"
```

---

### Task 6: Final verification (no subagent — controller does this directly)

Not a subagent task — this is the human-facing verification pass, same role as the embedded-terminal plan's Task 7.

- [ ] Run the full suite: `npx vitest run` — expect all green, no regressions in files this plan didn't touch.
- [ ] Run both tsc gates: `npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json` — expect exactly the documented baseline (17 node-tc / 2 web-tc, or whatever this branch's baseline is confirmed to be at the start of implementation), nothing above it.
- [ ] `npx eslint --fix` (scoped to touched paths only, never the whole repo) on every file this plan created or modified.
- [ ] Live-smoke in the dev build (`npm run dev`, after confirming no stale `electron-vite`/`electron` processes and clearing `node_modules/.vite`/`out` if this branch forked before recent unrelated changes):
  - Chrome bar: click the search icon → History view opens. Click the panel-toggle → sidebar collapses/expands. Confirm both are clickable (not swallowed by the traffic-light drag region).
  - With Hermes disabled: confirm no segmented toggle renders at all, sidebar shows Projects/Pinned/Recents directly.
  - With Hermes enabled: toggle between Conversations/`<hermesLabel>`, confirm the list actually swaps and "+ New Conversation" targets the right one in each mode.
  - Click a project row → `ProjectPage` opens with the right name/icon/color/count; click Settings/Terminal/New → each does what it did before (just relocated); click a conversation row → opens it; Pin toggles; rename/delete via the row's `⋮` menu.
  - Click "No folder" → `ProjectPage` opens with no Settings/Terminal buttons, "New" still creates a project-less conversation.
  - Pinned conversation shows in the Pinned section and does NOT also appear in Recents.
  - Footer: click the name → menu opens above it (not clipped off-screen); Settings opens the real modal; Dark Mode toggles the live theme and the checkmark updates.
  - Toggle System Appearance's dark/light OS setting (or the app's own Settings → Appearance) and re-check the footer's Dark Mode checkmark stays in sync.
  - Resize the window very short (or a very long conversation list) to confirm the Recents section scrolls internally without pushing the footer off-screen or under it (this is exactly the bug fixed during mockup iteration — verify the real component doesn't regress it).
- [ ] Report the live-smoke results back before treating this plan as done.
