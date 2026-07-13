# Signed, Notarized macOS Builds + In-App "Install Updates" — Design

**Status:** Approved
**Date:** 2026-07-12

## Problem

BearCode packages a macOS DMG (`electron-builder.yml`, `mac.dmg` target) but has no code
signing, no notarization (`mac.notarize: false`), and no way for a user to learn about or install
a new version short of manually re-downloading a DMG. Distribution has been deliberately deferred
as the "absolute last step" per project convention — this is the first real distribution-arc work.

## Goals

- Real Developer ID code signing + notarization for the packaged app, so it launches without a
  Gatekeeper warning.
- A working in-app update flow: check, download, and install a new version without the user
  re-downloading a DMG by hand.
- Reuse Zach's existing macOS-app conventions (App Store Connect API key notarization, gitignored
  local credential file) rather than inventing a new pattern.
- `1.0.0` is the first real, signed, notarized, updatable release.

## Non-Goals (this arc)

- GitHub Actions / CI-automated release builds. Publishing is a manual, local
  `npm run build:mac -- --publish always` for now.
- Windows or Linux auto-update (NSIS/AppImage have a different update story; out of scope here).
- Update channels (beta/stable), staged rollout percentages, or rollback UI.
- Custom update-hosting infrastructure — GitHub Releases only.

## Current State

- `electron-builder.yml`: `mac.entitlementsInherit: build/entitlements.mac.plist`,
  `mac.notarize: false`, `dmg.artifactName` set, no `mac.identity`, no `publish` config.
- `package.json` version is `0.1.0`. No `electron-updater` dependency. `build:mac` script is
  `electron-vite build && electron-builder --mac` (no `--publish`).
- No GitHub Actions workflows exist in this repo.
- A `Developer ID Application: The University of Montana (5JJ6G6A84S)` identity is already
  present in the local login keychain (`security find-identity -v -p codesigning`).
- Sibling native macOS apps (`~/GitHub/zMeet`, `~/GitHub/fiddle`) notarize via
  `scripts/notarize.sh` sourcing a gitignored `scripts/.notary-config.local` with
  `NOTARY_KEY` (path to an App Store Connect `.p8` key), `NOTARY_KEY_ID`, `NOTARY_ISSUER` — a
  committed `.notary-config.example` documents the shape. BearCode reuses this credential
  *pattern* (App Store Connect API key, gitignored local file) but not the shell script, since
  electron-builder has a native `mac.notarize` config that calls `@electron/notarize` directly.

## Design

### 1. Code signing & notarization (build-time config, no app code)

`electron-builder.yml` changes:

```yaml
mac:
  entitlementsInherit: build/entitlements.mac.plist
  hardenedRuntime: true
  identity: "Developer ID Application: The University of Montana (5JJ6G6A84S)"
  notarize:
    teamId: 5JJ6G6A84S
  target:
    - dmg
    - zip
dmg:
  artifactName: ${name}-${version}.${ext}
```

- `identity` pins the exact certificate rather than relying on auto-discovery, so a build fails
  loudly if the cert is ever missing/expired instead of silently producing an unsigned app.
- `hardenedRuntime: true` is required for notarization to succeed.
- `notarize.teamId` triggers electron-builder's built-in `@electron/notarize` call.
  `@electron/notarize` reads App Store Connect API key credentials from env vars:
  `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. These are exported
  from the same gitignored local file pattern as zMeet/Fiddle (see below), not hardcoded.
- Adding the `zip` target: `electron-updater`'s Mac provider downloads and applies a `.zip`
  (Squirrel.Mac), not the `.dmg`. The DMG remains the primary artifact a human downloads from the
  Releases page; the ZIP exists for the updater.

New files:

- `scripts/.notary-config.example` (committed) — documents `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER` shape, same style as the sibling repos' `.notary-config.example`.
- `.gitignore` gains `scripts/.notary-config.local`.
- `package.json` gains a `build:mac:publish` script:
  `set -a && source scripts/.notary-config.local && set +a && electron-vite build && electron-builder --mac --publish always`
  — sources the local credentials into the environment, then builds, signs, notarizes, and
  publishes in one command. Plain `npm run build:mac` (no publish) still works for a local,
  unpublished signed build as long as the same env vars are exported in the shell first.

`electron-builder.yml` also gains a top-level `publish` block — electron-builder reads its config
from either `package.json`'s `build` key or `electron-builder.yml`, and this repo already uses
`electron-builder.yml` as the single source of truth for every other setting, so `publish` goes
there too, not in `package.json`:

```yaml
publish:
  provider: github
  owner: umzcio
  repo: BearCode
```

`--publish always` uploads the DMG, ZIP, `latest-mac.yml`, and `.blockmap` files to a **draft**
GitHub Release (electron-builder's default when there's no CI-provided `GH_TOKEN` marking it
final) tagged `v${version}`. Zach publishes the draft manually from the GitHub UI once he's
confirmed the build.

`GH_TOKEN` (a personal access token with `repo` scope) must be exported in the shell for the
publish step to authenticate — documented in the plan's setup step, not stored anywhere in-repo.

### 2. Update flow (app code)

**Dependency:** add `electron-updater` to `dependencies`.

**`src/main/updater.ts`** (new module):

- Wraps `electron-updater`'s `autoUpdater` singleton.
- `autoDownload = true`, `autoInstallOnAppQuit = true`.
- `initUpdater(mainWindow)`: called once from `src/main/index.ts` after the main window is
  created. No-ops immediately if `!app.isPackaged` (matches `electron-updater`'s own
  unsigned/dev-build no-op behavior, so nothing needs to special-case dev mode beyond that).
- Checks on: startup (a few seconds after launch, so it doesn't compete with initial app
  boot/render), then every 4 hours on a `setInterval`.
- `checkNow(): Promise<UpdaterStatus>` — manual trigger for the Settings button; returns the
  current status immediately (see IPC below) rather than only firing events, so the Settings UI
  can show a result even if the renderer subscribed after the check started.
- Forwards `autoUpdater` events to the renderer via `mainWindow.webContents.send`:
  - `checking-for-update` → `{ state: 'checking' }`
  - `update-available` → `{ state: 'downloading', version }`
  - `update-not-available` → `{ state: 'up-to-date', checkedAt }`
  - `update-downloaded` → `{ state: 'ready', version }`
  - `error` → `{ state: 'error', message }`
- `installNow()`: calls `autoUpdater.quitAndInstall()`.

**IPC** (`src/main/ipc.ts` + `src/preload`): new `bearcode:updater:*` channels following the
existing typed-handler pattern used by every other `bearcode:*` surface:
- `bearcode:updater:checkNow` (invoke) → `Promise<UpdaterStatus>`
- `bearcode:updater:installNow` (invoke) → `void`
- `bearcode:updater:onStatus` (event subscription) → pushes `UpdaterStatus` on every state change

**Renderer:**

- A Zustand store slice (`updaterStatus: UpdaterStatus`, updated via the `onStatus` subscription
  set up once at app root) — same shape as other store slices in `src/renderer/src/state/store.ts`.
- **`UpdateBanner`** component: rendered at the app-shell level (sibling to the existing
  `trust-banner` / `outside-access-card` banners in `App.tsx`), shown only when
  `updaterStatus.state === 'ready'`. Reuses the `.trust-banner` CSS class and its existing
  `@starting-style` enter animation and `pill-btn`/`pill-btn.primary` button styling — this is
  explicitly *not* a new bespoke banner component, per the "reuse shared primitives" convention.
  Copy: `"BearCode {version} is ready to install."` with a primary **"Restart & Install"** button
  (calls `installNow()`) and a **dismiss** (×) that hides the banner for the rest of the session
  (state stays `ready`; it reappears on next launch until installed).
- **Settings → General**, new "Software Update" section (`GeneralPage.tsx`):
  - Current version (`app.getVersion()`, exposed via existing `bearcode:app:*` or a new
    `bearcode:app:getVersion` if none exists — confirmed at plan time).
  - A `Loading`/status line reflecting `updaterStatus.state`: "Checking…" / "Up to date (checked
    {relativeAge})" / "Downloading update…" / "Update ready — restart to install" / an
    `ErrorCard` on `error`.
  - A **"Check for Updates"** `pill-btn` calling `checkNow()`.
  - If `state === 'ready'`, the same "Restart & Install" action appears here too (not just in the
    banner), so a user who dismissed the banner can still act from Settings.

### 3. Versioning

`package.json` version bumps from `0.1.0` to `1.0.0` for this release — the first signed,
notarized, updatable build. Going forward, BearCode follows **`<major>.<build>.<patch>`**: bump
the middle "build" number for feature drops, the patch number for fixes, and major only for
breaking/large re-platforms. This is the same field `electron-updater` compares against
`latest-mac.yml` to decide whether an update is available, so every published release must bump
it.

## Error Handling

- `autoUpdater` `error` events (network failure, malformed `latest-mac.yml`, signature mismatch)
  surface as `{ state: 'error', message }` — shown via `ErrorCard` in Settings only; no error
  banner at the app-shell level (a background update-check failure shouldn't interrupt the user
  mid-task the way a ready-to-install banner earns interrupting them).
- If `checkNow()` is called while a check/download is already in flight, it returns the current
  in-flight status rather than starting a second concurrent check (`electron-updater` itself
  guards against concurrent `checkForUpdates()` calls, but the wrapper still needs to return
  something sane to the caller rather than racing IPC responses).
- Unsigned/unpackaged dev builds: `initUpdater` no-ops entirely (`!app.isPackaged` check) — the
  Settings section still renders but `checkNow()` resolves with a distinct `{ state: 'dev-build'
  }` status shown as a quiet note ("Auto-update is unavailable in development builds") instead of
  attempting a check that would only ever fail.

## Testing

- **Unit** (`src/main/updater.test.ts`): mock `electron-updater`'s `autoUpdater` (vitest module
  mock), verify each `autoUpdater` event maps to the correct forwarded status shape, verify
  `checkNow()`/`installNow()` call through to the right `autoUpdater` methods, verify the
  concurrent-check guard and the `!app.isPackaged` no-op path.
- **Renderer** (`GeneralPage.test.tsx` addition, new `UpdateBanner.test.tsx`): React Testing
  Library, following the existing `*Page.test.tsx` pattern — render with each `updaterStatus`
  state and assert the correct copy/controls appear; assert `checkNow`/`installNow` IPC calls
  fire on button click; assert the banner only renders on `state === 'ready'` and respects
  session-scoped dismissal.
- **Live-smoke (manual, documented as an explicit plan step, not automatable):** build+publish
  version A, install it, bump to version B, build+publish again, confirm the running version-A
  app finds, downloads, and installs version B via the "Restart & Install" flow, and that the
  resulting app is still correctly signed (`codesign --verify --deep --strict`) and notarized
  (`spctl -a -vv`) post-update.

## Open Items Resolved During Design

- **Signing:** Developer ID Application cert already in keychain (confirmed via
  `security find-identity`) — no new cert needed.
- **Notarization credentials:** App Store Connect API key, same pattern as zMeet/Fiddle, stored
  in a new gitignored `scripts/.notary-config.local`.
- **Update host:** GitHub Releases (`electron-updater`'s `github` provider).
- **Update UX:** auto-check + banner (reusing `.trust-banner`) + manual Settings check, one merged
  flow rather than three separate surfaces.
- **CI:** explicitly out of scope this arc; local `--publish always` only.
- **Versioning:** `<major>.<build>.<patch>`, starting at `1.0.0`.
