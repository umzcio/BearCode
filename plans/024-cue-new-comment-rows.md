# 024 — Cue newly inserted comment rows

- **Status**: DONE
- **Commit**: `2117058`
- **Severity**: LOW
- **Category**: Continuity / Feedback
- **Estimated scope**: 4 files, roughly 65 lines

## Problem

Both diff-review comments and artifact-plan comments use stable keyed rows, but newly inserted rows
appear without any local continuity cue:

```tsx
// src/renderer/src/components/artifactsPane/DiffPanel.tsx:320 — current
{comments.length > 0 ? (
  <>
    <div className="comment-list">
      {comments.map((c) => (
        <div className="comment-row" key={c.id}>
          <span className="comment-loc">
            {baseName(c.path)}:{c.line}
          </span>
          <span className="comment-text">{c.text}</span>
          <Hint label="Remove comment" side="top">
            <button
              className="comment-del"
              aria-label="Remove comment"
              onClick={() => removeDiffReviewComment(diffId, c.id)}
            >
              <IconClose size={12} />
            </button>
          </Hint>
        </div>
      ))}
    </div>
```

```tsx
// src/renderer/src/components/ArtifactViewer.tsx:360 — current
{comments.length > 0 ? (
  <div className="plan-comment-list">
    {comments.map((c) => (
      <div key={c.id} className="plan-comment-item">
        {c.quote ? <blockquote className="plan-comment-quote">{c.quote}</blockquote> : null}
        <div>{c.body}</div>
        <span className={'plan-comment-chip' + (c.sentAt === null ? ' draft' : '')}>
          {c.sentAt === null ? 'draft' : 'sent'}
        </span>
      </div>
    ))}
  </div>
) : null}
```

Their current styles contain layout and typography only:

```css
/* src/renderer/src/components/ArtifactsPane.css:161,397 — current */
.comment-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 6px;
  font-size: 12.5px;
  border-radius: 7px;
}

.plan-comment-item {
  margin: 10px 0;
  font-size: 12.5px;
  color: var(--text-mid);
}
```

After submission, the eye has to rediscover what changed. A restrained row-level entry can confirm
the insertion without moving the list or delaying interaction.

## Target

Apply the same 2px/150ms entry to both row families:

```css
/* src/renderer/src/components/ArtifactsPane.css — target */
.comment-row,
.plan-comment-item {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

@starting-style {
  .comment-row,
  .plan-comment-item {
    opacity: 0;
    transform: translateY(2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .comment-row,
  .plan-comment-item {
    transform: none;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  @starting-style {
    .comment-row,
    .plan-comment-item {
      opacity: 0;
      transform: none;
    }
  }
}

:root[data-motion='reduced'] .comment-row,
:root[data-motion='reduced'] .plan-comment-item {
  transform: none;
}

@starting-style {
  :root[data-motion='reduced'] .comment-row,
  :root[data-motion='reduced'] .plan-comment-item {
    transform: none;
  }
}
```

Under OS reduction, retain the permitted 150ms opacity feedback and remove all movement. The
in-app setting's global rule in `styles/tokens.css` collapses transition duration to 0.001ms, while
the explicit selectors above remove both transform endpoints. Removal remains immediate: do not
retain deleted rows for an exit.

## Repo conventions to follow

- `src/renderer/src/components/ArtifactsPane.css:339-353,1046-1064` implements this exact
  opacity-plus-2px entry and reduced-motion transform removal for `.plan-resolution-notice`.
  Mirror those values and rule structure.
- `src/renderer/src/styles/tokens.css:53,63` defines `--ease-out` and the 150ms `--dur-fast`.
- Both component maps already use stable `c.id` keys. Preserve them so existing siblings do not
  remount and replay when one row is added.
- The Monaco comment composer and send bar have their own motion. This plan affects only persisted
  row insertion feedback.

## Steps

1. In `src/renderer/src/components/ArtifactsPane.css`, augment the existing `.comment-row` and
   `.plan-comment-item` rules with the exact final opacity, transform, and transition values above.
   Add one shared `@starting-style` block with 0 opacity and `translateY(2px)`.
2. Add the exact OS reduced-motion block: remove transform from final and starting states while
   retaining `opacity var(--dur-fast) var(--ease-out)`.
3. Add the exact in-app final and `@starting-style` selectors that remove transform. Rely on the
   existing global duration collapse; do not duplicate it.
4. In `src/main/artifactsPaneMotionContract.test.ts`, add a reusable assertion for each row family:
   base opacity `1`, base `translateY(0)`, both exact transitions, starting opacity `0`, starting
   `translateY(2px)`, OS-reduced transform removal in both states, and in-app transform removal in
   both states.
5. Extend `src/renderer/src/components/ArtifactsPane.diff.test.tsx` to insert a second diff comment
   and assert the first `.comment-row` DOM node is retained by its stable key while the new row is
   added. Extend `src/renderer/src/components/ArtifactViewer.test.tsx` with the equivalent plan
   comment assertion. These are remount guards; jsdom is not expected to simulate CSS interpolation.
6. Run focused tests, typecheck, lint, and build. Visually test rapid insertion and removal because
   static contracts cannot detect distracting list motion.

## Boundaries

- Do NOT animate the whole `.comment-list`, `.plan-comment-list`, composer, or send bar.
- Do NOT add an exit animation or delay row removal.
- Do NOT change keys, comment ordering, submission behavior, or persistence.
- Do NOT exceed 2px or `var(--dur-fast)` (150ms).
- Do NOT use a spring, scale, blur, stagger, or JavaScript animation.
- Do NOT add dependencies.
- If a step does not match commit `2117058`, STOP and report the drift instead of improvising.

## Verification

- **Mechanical**:
  - `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ArtifactViewer.test.tsx src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npx eslint src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ArtifactViewer.test.tsx src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npm run typecheck` exits 0.
  - `npm run build` exits 0.
- **Feel check**: run the app and add comments in both a diff and a plan artifact:
  - Only the newly mounted row fades upward by 2px; existing rows remain visually stationary.
  - The row is clickable and removable immediately while entering.
  - Adding several comments rapidly does not stagger, move the entire list, or replay older rows.
  - Removing a comment remains immediate with no retained blank space.
  - In DevTools, set playback to 10% and confirm each new row uses exactly 150ms, never exceeds 2px,
    and has no scale or blur.
  - Toggle `prefers-reduced-motion` and confirm movement is dropped but the short opacity feedback
    remains; toggle the in-app setting and confirm insertion is effectively immediate.
- **Done when**: both stable-keyed row types receive the exact shared entry cue, existing siblings
  do not remount, removal remains immediate, both reduced-motion paths remove movement, and every
  command above passes.
