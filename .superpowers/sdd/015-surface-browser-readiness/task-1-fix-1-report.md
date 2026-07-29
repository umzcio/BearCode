# Task 1 fix round 1 report: harden browser readiness lifecycle

Status: DONE

## Fixes

- Added per-session manager generations and generation checks across install, view load, CDP connection/page resolution, theme reset, and the final ready transition.
- Crash/disconnect callbacks capture their owning generation; callbacks from replaced sessions are no-ops.
- Replaced teardown's early-return guard with one shared cleanup Promise that every teardown/restart joins.
- Isolated each status listener so one throwing observer cannot abort a transition or starve later observers.
- Made crash/disconnect failure handling best-effort-hide, always-cleanup, and finally-safe error publication.
- Gated manager `show()` on both `ready` phase and a connected page.
- Made BrowserPane feedback revision-based: non-ready and command-error surfaces remain unpainted until that revision's hide invoke resolves.
- Kept current hide rejection blank rather than rendering feedback that native pixels could cover; stale hide resolution/rejection cannot affect newer readiness.
- Made pending/current command errors a show gate across visibility toggles until a newer authoritative status clears them.
- Added `role="status"` with polite live semantics around preparing feedback without changing the shared Loading primitive globally.

## TDD evidence

- Manager RED reproduced listener escape, mid-theme crash/disconnect stale ready, overlapping teardown/restart, old callback ownership, hide-throw cleanup loss, and stale show exposure.
- Manager GREEN: 18/18.
- BrowserPane RED reproduced seven hide-ordering, stale-hide, show-gate, and loading-announcement failures.
- BrowserPane GREEN: 16/16.

## Verification

- Targeted manager + browser-control IPC + preload + BrowserPane suite: 4 files, 105/105 passed.
- Full node and renderer typecheck passed.
- Headed Electron browser harness passed hidden bounds, show latest bounds, navigation/read, screenshot, and teardown assertions.
- Scoped ESLint passed with no errors or warnings.
- `git diff --check` passed.

## Invariant and ownership notes

- No STOP condition was reached: BrowserPane can confirm hide before painting feedback. When confirmation rejects, feedback remains intentionally unpainted.
- `registerIpc()` still has one production call. Its browser-status subscription replacement remains module-owned cleanup for that listener only; neither the test nor this fix claims global `registerIpc()` idempotency, because real duplicate handler registration would fail first.
- README and ledger files were not edited.
