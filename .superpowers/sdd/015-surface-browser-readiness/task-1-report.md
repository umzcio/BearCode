# Task 1 report: surface embedded browser readiness

Status: DONE

## Implemented

- Added shared `BrowserPhase` and `BrowserStatus` contracts used by main, preload, renderer, and Settings.
- Added immutable manager status snapshots, unsubscribe-capable listeners, and explicit idle/starting/ready/error transitions.
- Sanitized failed-start messages to a single actionable line, preserved error state through cleanup, and documented/rendered `render-process-gone` as an actionable error.
- Scoped status pushes to the live authoritative main window and replaced prior subscriptions when `registerIpc()` is repeated.
- Added typed preload `browser.onStatus` listener registration and exact-listener cleanup.
- Made `BrowserPane` subscribe before hydration, reject stale initial results/errors, hide for every non-ready state, and show only after ready + connected + visible + settled geometry.
- Surfaced shared Loading, EmptyState, and ErrorCard feedback and guarded show/hide/setBounds failures against stale async completions.
- Removed the duplicate Settings browser status type in favor of the shared contract.

## TDD evidence

- Manager RED: 5 expected lifecycle/listener failures; GREEN: 8/8.
- IPC/preload RED: 5 expected push/subscription failures; GREEN: 70/70.
- BrowserPane RED: 12 expected lifecycle/gating/failure failures; GREEN: 13/13.
- Destroyed-authoritative-webContents push test was mutation-checked: it failed when the guard was removed and passed after restoration.

## Verification

- `npx vitest run src/main/browser/manager.visibility.test.ts src/main/ipc.browserControl.test.ts src/preload/index.test.ts src/renderer/src/components/Browser/BrowserPane.test.tsx` — 4 files, 92/92 passed.
- `npm run typecheck` — node and web typechecks passed.
- `npm run test:electron:browser` — build passed; hidden bounds, show latest bounds, navigation/read, screenshot, and teardown assertions passed.
- Scoped ESLint — exited 0 with no errors. It reports existing Prettier warnings on untouched lines in `ipc.ts`, `preload/index.ts`, `preload/index.test.ts`, and `shared/types.ts`.
- `git diff --check` — clean.

## Concerns

- None affecting correctness or delivery. Plan/README/ledger files were intentionally not edited per executor instructions.
