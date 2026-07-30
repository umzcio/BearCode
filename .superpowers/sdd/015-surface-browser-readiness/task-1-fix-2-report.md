# Task 1 fix round 2 report: make browser hide and connect race-safe

Status: DONE

## Fixes

- Made each CDP connection attempt own an attempt-local Playwright `Browser` until its session generation is proven current and page resolution succeeds.
- Passed the attempt-local browser into token-based page resolution instead of consulting shared manager state.
- Closed superseded successful connection handles locally; superseded rejections neither retry nor close a replacement session.
- Split the best-effort offscreen move used by crash/disconnect cleanup from the authoritative public hide operation.
- Made public hide asynchronous and authoritative: an offscreen bounds failure increments the session generation, synchronously detaches and closes the Electron native view, completes defensive session teardown, publishes an actionable error state, and then rejects.
- Returned the hide Promise from IPC so renderer callers settle only after main-process safety cleanup.
- Allowed BrowserPane to paint a current hide rejection as an `ErrorCard`, since a main-process rejection now guarantees the native view was detached; stale hide rejections remain ignored.

## TDD evidence

- Manager RED reproduced a superseded rejection closing the replacement browser, a superseded successful connection leaking its local handle, and an offscreen hide failure escaping before native detach.
- IPC RED reproduced hide invokes settling before manager cleanup and authoritative hide rejections being discarded.
- BrowserPane RED reproduced a current authoritative hide rejection remaining blank.
- Focused GREEN: manager + browser-control IPC + BrowserPane, 3 files, 97/97 passed.

## Verification

- Targeted manager + browser-control IPC + preload + BrowserPane suite: 4 files, 110/110 passed.
- Full node and renderer typecheck passed.
- Headed Electron browser harness passed hidden bounds, show latest bounds, navigation/read, screenshot, and teardown assertions.
- Scoped ESLint passed with no errors.
- `git diff --check` passed.

## Scope notes

- The headed harness did not require a call-site change; the successful hide path performs its offscreen move synchronously even though it now returns a Promise.
- README and ledger files were not edited.
