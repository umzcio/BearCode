# Artifacts Pane Motion Polish — Design

**Date:** 2026-07-27
**Status:** Implemented and follow-up audited

**Implementation note (2026-07-28):** The original motion scope shipped in commits `860168d`,
`887a93e`, `2afafc0`, `563a8b8`, `f9743a8`, `28ab9d9`, `59ef879`, and `102a212`. The subsequent
Artifacts Pane correctness, security, performance, accessibility, browser-lifecycle, export, and
module-boundary audit is tracked through plan 018 in
[`plans/README.md`](../../../plans/README.md). Those follow-ups preserve this design's persistent
shell, immediate high-frequency switching, native-view staging without per-frame IPC, 2000ms
signal-exit fail-safe, bounded Monaco height exception, and unchanged review-flow constraints.

## Context

The Artifacts Pane is BearCode's right-side review surface for file diffs,
plans, walkthroughs, attachments, arbitrary workspace files, and the embedded
browser. Its motion tokens are already strong and consistent with the rest of
the app:

- `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`
- `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`
- `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`
- `--dur-press: 140ms`
- `--dur-press-release: 100ms`
- `--dur-fast: 150ms`
- `--dur-menu: 180ms`
- `--dur-drawer: 340ms`

The audit found that the problems are not the curves themselves. Motion is
attached to the wrong lifecycle boundary, native browser pixels cannot inherit
renderer transforms, the pane's bespoke controls bypass established feedback,
and several occasional state changes have no continuity cue.

## Goals

- Run the 340ms drawer transition only when the pane itself opens or closes.
- Keep repeated artifact, diff, file, tab, and preview navigation immediate.
- Prevent the main-process `WebContentsView` from painting or receiving input
  while its renderer shell is moving.
- Remove positional motion under both OS and in-app reduced-motion settings.
- Eliminate the duplicated JavaScript copy of `--dur-drawer`.
- Bring pane controls into BearCode's existing press and color-transition
  vocabulary.
- Add restrained continuity to inline comments, review resolution, and
  asynchronous preview arrival.
- Remain dependency-free and preserve all current review, preview, browser, and
  attachment behavior.

## Non-goals

- No new motion library, spring library, or animation dependency.
- No redesign of the pane's visual layout, rail information architecture, or
  review workflow.
- No per-frame renderer-to-main IPC to drag the native browser view alongside a
  CSS transform.
- No animation when switching among high-frequency pane contents; only control
  press feedback and short color changes apply there.
- No change to browser session lifetime, navigation policy, Playwright control,
  attachment verification, or preview sandboxing.
- No broad refactor of `useAnimatedUnmount` consumers outside what is required
  for an event-completed Artifacts Pane exit.

## Design

### Persistent pane shell

`ArtifactsPane` will own one persistent `.ap-panel` DOM element for every target
kind. Browser, file, attachment, artifact, empty, and diff modes will render
inside that shell rather than each returning their own panel root.

Keys may still reset target-specific inner content where correctness requires
it, but a key must never replace `.ap-panel`. Switching between rail entries or
deep-link targets therefore updates content without replaying
`@starting-style`.

The existing accepted layout behavior remains unchanged: the flex slot appears
or disappears in one reflow, while the shell surface translates from or to the
right edge using `--dur-drawer` and `--ease-drawer`.

### Transition-completed presence

The pane will stop passing a hardcoded `340` to `useAnimatedUnmount`. Its closing
presence will be completed by the shell's own `transitionend` signal:

- only a transition event whose target is the shell itself is eligible;
- normal motion completes on the shell's `transform` transition;
- reduced motion skips deferred unmount and never waits for an event;
- a closing transition interrupted by reopening is not allowed to unmount the
  reopened pane; and
- a conservative, non-visual safety timeout prevents permanent retention if a
  platform fails to emit `transitionend`, but it does not define or truncate
  the visible duration.

`useAnimatedUnmount` will gain an opt-in
`exitCompletion: 'timer' | 'signal'` option and return a `completeExit()`
callback. `timer` remains the default so existing consumers keep their current
behavior. The Artifacts Pane uses `signal`; while it is closing,
`completeExit()` unmounts it, and while it is open the callback is a no-op. A
2000ms fail-safe prevents permanent retention if the platform never emits
`transitionend`; this is deliberately much longer than the visible transition.

### Native browser staging

The selected approach preserves drawer motion for the shell without attempting
per-frame `WebContentsView.setBounds()` calls.

The pane tracks whether its shell is settled:

1. On the first closed-to-open transition, the browser placeholder may mount and
   report geometry, but the native view remains hidden.
2. When the shell's own opening `transform` transition ends, the placeholder
   reports final bounds again and only then calls `browser.show()`.
3. If browser mode is selected while an already-open shell is settled, it
   reports bounds and shows immediately; no drawer transition is replayed.
4. As soon as the pane starts closing or switches away from browser mode,
   `browser.hide()` runs before renderer motion or content replacement.
5. The existing resize observer continues synchronizing ordinary pane resizing
   after the view is visible.

The placeholder will receive an explicit visibility/settled prop so this
sequencing is testable. DOM `pointer-events` is not treated as protection for a
native child view.

### Pane control feedback

The pane's segmented buttons, action buttons, deliverable rail items, file
tabs, version chips, overview-file rows, plan-review actions, comment actions,
and send controls will use BearCode's existing restrained feedback:

- background and color: `var(--dur-fast)` with `ease`;
- border color, when applicable: `var(--dur-fast)` with `ease`;
- press release: `transform var(--dur-press-release) var(--ease-out)`;
- active press: `scale(0.97)` with
  `transform var(--dur-press) var(--ease-out)`.

Disabled controls never scale. High-frequency selection remains immediate at
the React/state level; these transitions only acknowledge the physical press
and soften color changes.

Both `@media (prefers-reduced-motion: reduce)` and
`:root[data-motion='reduced']` remove active transforms.

### Reduced-motion parity

The existing OS reduced-motion treatment for `.ap-panel` will be mirrored for
the in-app setting:

- `@starting-style` has no `translateX`;
- closing has no `translateX`;
- the full-width movement is removed rather than compressed into `0.001ms`;
- the OS path may retain its current brief opacity transition; and
- the in-app blanket duration override remains authoritative unless a local
  opacity-only rule intentionally overrides it.

Browser visibility skips the settle wait when either reduced-motion signal is
active.

### Interruptible inline comment expansion

Opening the Monaco inline comment composer currently inserts a 56px view zone
in one frame. Closing removes it in one frame. The composer will instead use an
interruptible, requestAnimationFrame-driven view-zone height transition. A
small shared motion-token reader will parse CSS time and cubic-bezier custom
properties from `:root`; missing or invalid tokens cause the interaction to
snap to its final state instead of inventing a parallel fallback value.

The transition uses:

- duration read from `--dur-menu` (currently 180ms);
- easing read from `--ease-out` (currently
  `cubic-bezier(0.23, 1, 0.32, 1)`);
- opening: zone height progresses from `0` to the measured bar height plus its
  existing 12px allowance;
- closing: current height progresses to `0`, then the zone and overlay are
  removed;
- reopening or closing mid-transition cancels the previous frame loop and
  continues from the current height;
- input growth retargets from the current zone height to the new measured
  height;
- OS or in-app reduced motion applies the final height immediately; and
- disposal cancels any pending animation frame.

This is a deliberate exception to the transform/opacity-only default because
Monaco's view-zone height is the layout contract that keeps code from being
covered. The transition is rare, bounded to one zone, cancelable, and tested.
The comment bar itself also enters with a short opacity and 4px
`translateY(-4px)` transition so the surface and displaced code read as one
event.

### Review-resolution acknowledgment

Proceed and Review keep their current asynchronous behavior and must never wait
for animation before resolving the tool call.

After a successful resolution, the action slot will briefly show one of two
stable acknowledgments:

- `Approved`
- `Feedback sent`

The acknowledgment uses `role="status"`/polite live announcement, enters with
`var(--dur-fast)` opacity plus a 2px vertical offset, and remains readable for
1200ms. Under reduced motion the offset is removed. It is cleared immediately
when the selected artifact changes, and any timer is cleared on unmount.

Failures retain the existing editable review state and do not show success.
Buttons are disabled while their request is pending so duplicate resolution
cannot be submitted.

### Preview arrival

`FilePreview` and `AttachmentPreview` will render resolved `PreviewContent`
inside one shared entry wrapper. The wrapper mounts only for a payload belonging
to the current file or attachment and transitions opacity from `0` to `1` over
`var(--dur-fast)` with `var(--ease-out)`.

Loading text remains immediate. There is no overlapping crossfade and no delay
before iframe, image, PDF, table, Markdown, text, or Monaco content becomes
interactive. Reduced motion removes the transition while preserving the final
visible state.

## Error Handling and Edge Cases

- Reopening during close retargets the CSS transition and cancels pending exit
  completion.
- Target changes during an open pane never reset the shell's settled state.
- Browser IPC rejection remains non-fatal; cleanup still hides the view on
  switch or unmount.
- A native browser session that does not yet exist may receive bounds/show
  calls as today; `BrowserManager` retains the last bounds for later creation.
- Preview promises remain guarded against stale file, attachment, and
  conversation IDs.
- Comment-zone animation is canceled before the Monaco editor or model is
  disposed.
- Review-resolution notice timers cannot leak across artifacts or component
  unmounts.

## Testing

Implementation follows test-driven development.

Renderer and hook tests will cover:

- one `.ap-panel` DOM node surviving diff-ID, diff-to-artifact, file, and
  attachment target changes;
- drawer entry applying only to a closed-to-open mount;
- close remaining mounted until an eligible shell `transitionend`;
- reopen-before-transition-end preserving the pane;
- reduced motion unmounting immediately;
- browser mount reporting bounds while staying hidden;
- browser show occurring only after settled final bounds;
- browser hide occurring before close or target replacement;
- already-settled browser selection showing without a drawer wait;
- pane controls carrying the shared transition and active-state contract;
- both reduced-motion signals removing panel and button transforms;
- comment-zone open, close, retarget, reduced-motion, and disposal behavior
  under mocked animation frames;
- successful approval and feedback acknowledgments, request failure, duplicate
  submission prevention, timer cleanup, and artifact-switch cleanup; and
- file and attachment preview wrappers appearing only for current resolved
  payloads.

Regression verification will run:

- focused Artifacts Pane, BrowserPane, Monaco commenting, ArtifactViewer,
  FilePreview, AttachmentPreview, motion-helper, and presence-hook tests;
- the complete Vitest suite;
- renderer and Node typechecks;
- lint; and
- the production Electron build.

## Acceptance Criteria

1. Opening a closed Artifacts Pane uses the existing 340ms drawer motion.
2. Switching among diffs, artifacts, files, attachments, tabs, and preview modes
   never replays the drawer entrance.
3. Native browser pixels are hidden while the shell moves, appear only at final
   bounds, and cannot intercept input during close.
4. All pane control families provide subtle press feedback consistent with the
   rest of BearCode and remove that transform under reduced motion.
5. OS and in-app reduced-motion settings both remove full-width pane movement.
6. No JavaScript constant duplicates the visible drawer duration.
7. Inline comment insertion and removal no longer move following code in one
   frame, remain interruptible, and snap under reduced motion.
8. Successful plan approval and feedback submission produce a brief accessible
   acknowledgment without delaying the underlying action.
9. Resolved file and attachment previews enter with a brief opacity transition
   and never show stale payloads.
10. Existing diff review, artifact review, attachment preview/download, embedded
    browser, resize, and close behavior remains functionally unchanged.
