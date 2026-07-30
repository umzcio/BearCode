# Plan 007: Authorize and validate native browser-control IPC

> **Executor instructions**: Follow each step and command. Do not broaden this into a general IPC
> rewrite. Update `plans/README.md` on completion.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/main/ipc.ts src/main/browser/manager.ts src/main/browser/manager.visibility.test.ts src/main/mainWindow.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: security
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

The renderer can currently pass arbitrary values into `WebContentsView.setBounds` and toggle the
native view without proving the call came from the app’s main frame. A native child view can paint
and receive input above renderer DOM, so this control surface deserves an explicit trust boundary.
The fix must reject malformed geometry and unauthorized frames before mutating manager state.

## Current state

`ipc.ts:1030-1042` registers:

```ts
ipcMain.handle('bearcode:browser:set-bounds', (_e, b) => browserManager.setBounds(b))
ipcMain.handle('bearcode:browser:show', () => browserManager.show())
```

`bearcode:browser:hide` is registered separately at `ipc.ts:1881`. Status and clear-session are also
unguarded. `BrowserManager.setBounds` at `manager.ts:287-298` trusts the object and forwards it to
Electron. The app’s authoritative window is available through
`getMainWindow()`/`webContents.mainFrame` in `src/main/mainWindow.ts`.

The terminal boundary at `ipc.ts:1048-1068` is the local validation exemplar: accept `unknown`,
validate every runtime property, then narrow. Other wire guards in `ipc.ts:1395-1414` return a
validated object rather than using a bare cast.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| IPC tests | `npx vitest run src/main/ipc.browserControl.test.ts` | all pass |
| Manager tests | `npx vitest run src/main/browser/manager.visibility.test.ts` | all pass |
| Node typecheck | `npm run typecheck:node` | exit 0 |
| Lint | `npx eslint src/main/ipc.ts src/main/browser/ipcGuard.ts src/main/ipc.browserControl.test.ts` | exit 0 |

## Scope

**In scope**:

- `src/main/browser/ipcGuard.ts` (create)
- `src/main/browser/ipcGuard.test.ts` (create if pure guards are split)
- `src/main/ipc.ts`
- `src/main/ipc.browserControl.test.ts` (create)
- `src/main/browser/manager.ts` and visibility tests only if a defensive invariant belongs there

**Out of scope**:

- Browser navigation/domain policy, Playwright, session lifetime, or preview sandboxing
- A repository-wide sender authorization framework
- Per-frame bounds IPC
- Renderer layout changes

## Git workflow

- Branch: `advisor/007-harden-browser-control-ipc`
- Commit: `fix: harden native browser control ipc`

## Steps

### Step 1: Write failing boundary tests

Capture registered handlers the same way `src/main/ipc.attachmentSave.test.ts` does. Mock one
authoritative `BrowserWindow` with `webContents`, `mainFrame`, and content bounds. Cover:

- the real main frame may call status, clear-session, set-bounds, show, and hide;
- a subframe of the same webContents is rejected;
- a different sender/webContents is rejected;
- null, arrays, strings, missing keys, NaN, Infinity, fractions if integers are required,
  non-positive dimensions, negative origins, and rectangles outside content bounds are rejected;
- an accepted rectangle reaches `manager.setBounds` unchanged;
- rejected inputs never call any manager mutation.

Use fresh event objects; do not cast `{}` as a valid event.

**Verify**: tests fail against current handlers.

### Step 2: Add a narrow authorization and geometry guard

In `src/main/browser/ipcGuard.ts`, implement pure/testable helpers:

- `assertBrowserControlSender(event, mainWindow)` requires both the authoritative webContents and
  its `mainFrame`. Reject subframes and destroyed/missing windows.
- `parseBrowserBounds(raw, contentBounds)` accepts only an object with exactly usable finite numeric
  `x`, `y`, `width`, `height`; rounds only if the renderer contract intentionally allows fractions.
  Require positive size and containment within the current window content coordinate space.

Use concise errors without echoing large attacker-controlled objects. Treat all IPC arguments as
`unknown` until the guard succeeds.

**Verify**: pure guard tests pass.

### Step 3: Gate every browser-control handler consistently

Apply sender authorization to `status`, `clear-session`, `set-bounds`, `show`, and `hide`. Apply
geometry parsing to set-bounds. Co-locate hide with the other browser handlers unless registration
order is load-bearing (it is not expected to be).

Optionally keep a second defensive finite/positive assertion inside `BrowserManager.setBounds` if
the manager has other untrusted callers; do not clamp invalid inputs silently.

**Verify**: all IPC tests pass and rejected requests have zero manager calls.

### Step 4: Run focused regression and type checks

Run the commands in the table plus:

```bash
npx vitest run src/main/browser/manager.test.ts src/renderer/src/components/Browser/BrowserPane.test.tsx
```

Expected: pass.

## Test plan

Test authorization and validation separately, then one handler integration. Include boundary-equal
rectangles and one-pixel overflow. Confirm `hide` is gated too; it is easy to miss because it is
currently registered 800 lines away.

## Done criteria

- [ ] Every browser-control handler authorizes the app’s main frame.
- [ ] `set-bounds` accepts no malformed/nonfinite/out-of-window rectangle.
- [ ] Rejections mutate no manager state.
- [ ] Valid BrowserPane bounds continue to work.
- [ ] Focused tests, node typecheck, and lint pass.
- [ ] README row updated.

## STOP conditions

- Electron’s event identity differs in production such that `senderFrame === mainFrame` is not a
  reliable main-frame check; document evidence before choosing another identity check.
- Legitimate pane coordinates are outside content bounds because of CSS zoom/device-scale
  conversion. Stop and measure rather than weakening validation.
- More than one app window legitimately owns the Artifacts Pane.

## Maintenance notes

Any new native-view mutation belongs behind the same sender guard. Reviewers should test subframe
events explicitly; checking only `event.sender` authorizes iframes inside the privileged renderer.
