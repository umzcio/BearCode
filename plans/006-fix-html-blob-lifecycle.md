# Plan 006: Allocate HTML preview blob URLs only after commit

> **Executor instructions**: Follow steps and gates exactly. Update the plan index when complete.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/FilePreview/PreviewContent.tsx src/renderer/src/components/FilePreview/PreviewContent.test.tsx src/renderer/src/main.tsx`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: bug
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

`URL.createObjectURL` is an external resource allocation performed during render. React may abandon
or replay renders; `main.tsx` deliberately enables StrictMode, so a render-created URL is not
guaranteed to receive effect cleanup. Moving allocation to the committed effect lifecycle prevents
leaks while preserving the sandboxed blob preview.

## Current state

`PreviewContent.tsx:16-25`:

```tsx
const url = useMemo(
  () => URL.createObjectURL(new Blob([html], { type: 'text/html' })),
  [html]
)
useEffect(() => () => URL.revokeObjectURL(url), [url])
return <iframe sandbox="allow-scripts" src={url} />
```

- The explanatory comment incorrectly claims render allocation is safe.
- `main.tsx:14-18` renders the app inside `<StrictMode>`.
- `PreviewContent.test.tsx:14-21` already spies on create/revoke but does not assert lifecycle
  pairing.
- Security constraints are load-bearing: keep a blob URL (not `srcDoc`), keep
  `sandbox="allow-scripts"`, and never add `allow-same-origin`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `npx vitest run src/renderer/src/components/FilePreview/PreviewContent.test.tsx` | all pass |
| Typecheck | `npm run typecheck:web` | exit 0 |
| Lint | `npx eslint src/renderer/src/components/FilePreview/PreviewContent.tsx src/renderer/src/components/FilePreview/PreviewContent.test.tsx` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/FilePreview/PreviewContent.tsx`
- `src/renderer/src/components/FilePreview/PreviewContent.test.tsx`

**Out of scope**:

- Preview sandbox policy, protocol URLs, or other payload kinds
- Removing StrictMode
- Caching blob URLs globally
- Adding a loading animation

## Git workflow

- Branch: `advisor/006-fix-html-blob-lifecycle`
- Commit: `fix: commit html preview blob resources`

## Steps

### Step 1: Add lifecycle regression tests

Make `createObjectURL` return a distinct value each time. Add tests under `<StrictMode>` that:

- every created URL is eventually revoked on unmount;
- changing `html` revokes the prior committed URL and uses a URL created for the new value;
- non-HTML payloads allocate no blob;
- the iframe never gains `allow-same-origin`.

Do not assert an exact StrictMode allocation count; React versions may replay effects differently.
Assert set containment: all created URLs are revoked after unmount, and no URL is revoked before it
has been created.

**Verify**: the lifecycle-pairing case fails against render allocation or exposes its ambiguity.

### Step 2: Move resource ownership into an effect

Replace `useMemo` with state carrying both the source `html` and its URL. In an effect:

1. create the Blob and URL;
2. publish `{ html, url }` for the committed input;
3. revoke that exact URL in cleanup.

During the render between an `html` prop change and the new effect, do not render the old URL as if
it belonged to the new HTML. Render a stable empty/loading frame or omit `src` until
`resource.html === html`. Keep the surrounding `.file-preview.html` footprint stable.

Update the comment to state that allocation/revocation are effect-owned.

**Verify**: all lifecycle and existing rendering tests pass.

### Step 3: Run the gate

Run commands in the table.

## Test plan

Cover mount, StrictMode replay, prop change, unmount, and non-HTML. Preserve existing sandbox and
blob-src assertions.

## Done criteria

- [ ] No `createObjectURL` call occurs in render/useMemo.
- [ ] Every committed URL is revoked exactly once by its cleanup.
- [ ] Stale HTML never renders under a new prop.
- [ ] Sandbox remains `allow-scripts` without same-origin.
- [ ] Tests, typecheck, and lint pass.
- [ ] README status updated.

## STOP conditions

- ESLint’s hooks rules reject the standard effect-owned resource pattern and the only apparent fix
  is disabling the rule globally.
- The iframe must use `srcDoc` to make tests pass.
- React produces a state-update-after-unmount warning.

## Maintenance notes

Any future resource type with explicit release semantics belongs in commit/effect lifecycle, not
render. Review the prop-change frame for stale content as carefully as the leak.
