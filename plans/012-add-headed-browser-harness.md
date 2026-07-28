# Plan 012: Add a real headed-Electron native browser-view gate

> **Executor instructions**: This plan creates a dedicated harness, not a user feature. Run it in a
> real headed Electron environment and make failures explicit; never silently skip. Update the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- package.json electron.vite.config.ts src/main/browser/manager.ts src/main/browser/manager.test.ts src/main/index.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/007-harden-browser-control-ipc.md`
- **Category**: tests
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

`manager.test.ts:25-52` labels itself “live only” but catches startup failure and returns from every
assertion, so plain Vitest reports green without exercising Electron, a real `WebContentsView`, CDP,
Playwright, visibility, or teardown. Mocks cover logic but cannot detect native-view API/runtime
breakage. A dedicated command must either run those assertions or fail loudly.

## Current state

- `manager.test.ts:29-45` sets `live = false` on any startup error and each test does
  `if (!live) return`.
- `manager.visibility.test.ts` injects a fake private view; it is valuable unit coverage but not an
  integration gate.
- Electron 43 and Playwright are already dependencies; do not add an E2E framework.
- `electron.vite.config.ts` has named main inputs `index` and `officeWorker`.
- `mainWindow.ts` exposes setters for the authoritative window/debugging state.
- `BrowserManager.start()` requires a real window, enabled remote debugging on fixed loopback port
  9333, Chromium availability, and a view that can be found by its token.
- The approved design forbids changing browser session lifetime, navigation policy, or per-frame
  view motion.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Unit tests | `npx vitest run src/main/browser/manager.visibility.test.ts` | all pass |
| Build harness | `npm run build` | exit 0; harness entry emitted |
| Headed gate | `npm run test:electron:browser` | exit 0 with named assertions, no SKIP |
| Node typecheck | `npm run typecheck:node` | exit 0 |

## Scope

**In scope**:

- `src/main/browser/electronHarness.ts` (create)
- `electron.vite.config.ts`
- `package.json`, `package-lock.json` only if script resolution changes lock metadata
- `src/main/browser/manager.test.ts` (remove misleading live-only tests or convert them to explicit
  unit cases)
- `docs/testing.md` (create only if no testing doc exists and command needs headed prerequisites)

**Out of scope**:

- Running in headless Vitest or silently skipping without a display
- Downloading Chromium during every ordinary `npm test`
- Changing production browser policy/session code to satisfy the harness
- Screenshots containing user data

## Git workflow

- Branch: `advisor/012-add-headed-browser-harness`
- Commit: `test: add headed native browser harness`

## Steps

### Step 1: Build an assertion-driven Electron entry

Create `electronHarness.ts` as a separate main entry. Before `app.whenReady`, enable loopback remote
debugging on the same port used by `BrowserManager`. After ready:

1. create a minimal shown `BrowserWindow` with a harmless local/data document;
2. call `setMainWindow(win)` and `setBrowserDebuggingEnabled(true)`;
3. instantiate a fresh `BrowserManager`;
4. set known bounds while hidden, start a unique test conversation, and inspect the actual
   `WebContentsView` bounds through a harness-only typed cast;
5. assert hidden bounds are offscreen, `show()` restores exact bounds, resizing while hidden stays
   offscreen, and re-show uses latest bounds;
6. navigate to deterministic HTML, read expected text, and assert screenshot output is a nontrivial
   PNG data URL;
7. teardown and assert the child view’s webContents is destroyed/detached;
8. close the window and `app.exit(0)`.

Catch at top level, print one concise assertion name/error, clean up, and `app.exit(1)`. Use a timeout
that exits 1. Do not access user settings or conversations.

**Verify**: deliberately invert one assertion locally and confirm the process exits 1; restore it.

### Step 2: Add a build input and explicit npm command

Add a named `browserHarness` main input. Add `test:electron:browser` that builds the required entry
and launches it with the project Electron binary. The ordinary `npm test` remains fast and does not
invoke headed Electron.

The command must print lines such as:

```text
PASS hidden bounds
PASS show latest bounds
PASS navigation/read
PASS screenshot
PASS teardown destroys view
```

No “live=false”, “skip”, or exit-0 fallback is allowed.

**Verify**: headed command exits 0 and emits every marker exactly once.

### Step 3: Remove the misleading silent-live Vitest path

Delete the guarded pseudo-live cases from `manager.test.ts` or replace them with deterministic unit
tests that never claim native coverage. Keep visibility unit tests. Document the headed command near
the harness or in `docs/testing.md`, including display and Chromium prerequisites.

**Verify**:

```bash
rg -n "if \\(!live\\) return|live only|sets live=false|skip" src/main/browser
```

Expected: no silent-pass pattern in browser tests/harness.

### Step 4: Run all checks

Run commands in the table. Run the headed command twice to catch teardown/port leakage.

## Test plan

The harness covers actual view construction, hidden/show/resized bounds, token-based CDP
attachment, navigation/read, screenshot, and teardown. Unit tests continue to cover detailed
manager branches. A missing display/Chromium/port is a failed prerequisite, not a green test.

## Done criteria

- [ ] A named npm command launches real Electron and WebContentsView.
- [ ] It cannot exit 0 without executing every named assertion.
- [ ] Native visibility, CDP read/screenshot, and teardown are covered.
- [ ] Running twice does not leave port/process/view residue.
- [ ] Ordinary Vitest contains no silent pseudo-live success.
- [ ] Build/typecheck/unit tests pass; index updated.

## STOP conditions

- The fixed CDP port is already owned by another process; report the owner rather than killing it.
- The environment has no headed display. Report the unmet prerequisite; do not add a skip.
- Accessing the real view requires adding a production public test-only method. Prefer a harness-only
  cast; stop if Electron uses inaccessible `#private` state.
- Chromium installation would require network or user-global mutation not authorized by the operator.

## Maintenance notes

This command should be required for browser/native-view changes, not every renderer-only PR.
Reviewers should look for any new catch that converts setup failure to success.
