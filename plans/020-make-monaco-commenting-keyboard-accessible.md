# 020 — Make Monaco commenting keyboard accessible

- **Status**: DONE
- **Commit**: `2117058`
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 3 files, roughly 90 lines

## Problem

The Monaco comment composer can be opened only by clicking the gutter or a floating button that is
created hidden and shown only after pointer movement:

```ts
// src/renderer/src/components/monacoCommon.ts:287 — current
const mouse = ed.onMouseDown((e) => {
  const t = e.target
  if (
    (t.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      t.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) &&
    t.position
  ) {
    openComposer(t.position.lineNumber)
  }
})

const fab = document.createElement('button')
fab.className = 'comment-fab'
fab.innerHTML = FAB_SVG
fab.style.display = 'none'
container.appendChild(fab)
```

The button has no type, accessible name, shortcut metadata, or focus treatment. Its explanatory
tooltip is hover-only and runs on devices that do not have a precise hover pointer:

```css
/* src/renderer/src/components/ArtifactsPane.css:267 — current */
.comment-fab::before {
  content: 'Comment';
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) ease;
}
.comment-fab:hover::before {
  opacity: 1;
}
```

Keyboard-only reviewers cannot open the composer at the cursor line, and focus users do not receive
the same label feedback as pointer users.

## Target

Register one Monaco editor action that opens the existing composer at the current cursor line:

```ts
// src/renderer/src/components/monacoCommon.ts — target shape
const commentAction = ed.addAction({
  id: 'artifacts.addReviewComment',
  label: 'Add review comment',
  keybindings: [
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC
  ],
  run: () => {
    const lineNumber = ed.getPosition()?.lineNumber
    if (lineNumber !== undefined) openComposer(lineNumber)
  }
})
```

The chord is `Control+Alt+C` on Windows/Linux and `Command+Option+C` on macOS. It is scoped to the
focused embedded editor through `ed.addAction`; do not add a window-level listener.

Make the floating button a complete native control:

```ts
fab.type = 'button'
fab.setAttribute('aria-keyshortcuts', 'Control+Alt+C Meta+Alt+C')
// Whenever the visible target changes:
fab.setAttribute('aria-label', `Comment on line ${fabLine}`)
```

Keep the tooltip's existing opacity timing because hover opacity is one of the cases where built-in
`ease` is appropriate. Add a visible focus ring and make tooltip triggers input-aware:

```css
/* target */
.comment-fab:focus-visible {
  outline: 2px solid var(--ap-accent-blue);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .comment-fab:hover::before {
    opacity: 1;
  }
}

.comment-fab:focus-visible::before {
  opacity: 1;
}
```

The FAB remains pointer-proximity UI; the editor action is the always-available keyboard path.
Dispose the registered action with every existing Monaco listener.

## Repo conventions to follow

- `src/renderer/src/components/monacoCommon.ts:184-285` owns all composer creation and teardown.
  Both pointer and keyboard entry must call the same `openComposer(lineNumber)` function.
- `src/renderer/src/components/ArtifactsPane.css:537-542` uses a two-pixel
  `var(--ap-accent-blue)` focus outline for pane controls; match it.
- `src/renderer/src/components/ArtifactsPane.css:267-287` already uses
  `opacity var(--dur-fast) ease` for this tooltip. Preserve its 150ms opacity-only transition.
- `src/renderer/src/components/monacoCommon.test.ts` supplies a typed fake editor. Extend that fake
  rather than weakening production types.

## Steps

1. In `src/renderer/src/components/monacoCommon.ts`, set the generated FAB's `type` to `button`, add
   the cross-platform `aria-keyshortcuts` value, and update its `aria-label` to name the currently
   targeted line whenever it is shown.
2. Register the exact `artifacts.addReviewComment` editor action above. Read the line from
   `ed.getPosition()` at invocation time; do not reuse the last hovered line. If the editor has no
   cursor position, return without opening a composer.
3. Dispose the action in `attachCommenting(...).dispose()` alongside `mouse`, `move`, and `scroll`.
4. In `src/renderer/src/components/ArtifactsPane.css`, move only the tooltip's hover-to-visible rule
   into `@media (hover: hover) and (pointer: fine)`. Add the exact focus-visible outline and
   focus-visible tooltip rule above. Do not change the tooltip duration, easing, position, or
   surface styling.
5. Extend the `monaco-editor` mock and `fakeEditor()` in
   `src/renderer/src/components/monacoCommon.test.ts` with `KeyMod`, `KeyCode`, `addAction`, and
   `getPosition`. Capture the action registration and assert its ID, label, exact chord, and
   disposal.
6. Add tests invoking the captured action at two cursor lines and assert the composer is anchored
   to the current line each time. Cover the no-position case. Show the FAB through the existing
   mouse-move fake and assert `type="button"`, the exact accessible label, and shortcut metadata.
7. Extend `src/main/artifactsPaneMotionContract.test.ts` with rule-aware assertions that the hover
   tooltip rule exists only inside the fine-hover media query and that focus-visible independently
   reveals it without changing the base opacity transition.

## Boundaries

- Do NOT add a global keydown listener or intercept the shortcut outside a focused Monaco editor.
- Do NOT change the gutter-click or floating-button click behavior.
- Do NOT make the FAB permanently visible.
- Do NOT open at the last hovered line from the keyboard action; use the current cursor.
- Do NOT change `opacity var(--dur-fast) ease` to a transform or a different easing.
- Do NOT add dependencies.
- If a step does not match commit `2117058`, STOP and report the drift instead of improvising.

## Verification

- **Mechanical**:
  - `npx vitest run src/renderer/src/components/monacoCommon.test.ts src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npx eslint src/renderer/src/components/monacoCommon.ts src/renderer/src/components/monacoCommon.test.ts src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npm run typecheck` exits 0.
  - `npm run build` exits 0.
- **Feel check**: run the app, focus a changed line in a diff, and confirm:
  - `Command+Option+C` on macOS or `Control+Alt+C` on Windows/Linux opens the same composer as a
    gutter click, on the cursor line rather than the last hovered line.
  - The pointer FAB still follows hovered lines and clicking it opens the correct composer.
  - Tabbing to a visible FAB shows a crisp focus ring and the same “Comment” tooltip.
  - A coarse-pointer emulation does not trigger hover-only tooltip behavior.
  - In DevTools, set playback to 10% and confirm the tooltip performs only the existing 150ms
    opacity fade, with no scale or positional drift introduced by this plan.
  - Toggle `prefers-reduced-motion` and confirm keyboard entry remains immediate and usable.
- **Done when**: the focused editor always exposes a documented keyboard action at the cursor line,
  the generated button has complete accessible metadata and focus feedback, pointer behavior is
  unchanged, the action is disposed correctly, and every command above passes.
