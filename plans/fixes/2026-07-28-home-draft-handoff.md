# Home Accepted-Draft Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every Home Composer edit made during an accepted first-run dispatch by handing
the exact remaining draft to the newly opened conversation.

**Architecture:** A renderer-only draft value and focused hook make snapshot subtraction atomic.
`startFromHome` records acceptance without navigating; Home completes ownership transfer with a
one-shot store handoff, and ConversationView seeds and acknowledges that handoff after Composer
initialization.

**Tech Stack:** React 19, TypeScript 6, Zustand, Vitest, Testing Library.

## Global Constraints

- Keep `startFromHome(...): Promise<boolean>`; `true` means `run.start` accepted ownership.
- Preserve text, command, mentions, and attachments added or changed after the submitted snapshot.
- Do not disable editing while dispatch is pending.
- The handoff is renderer-session-only: no persistence, schema, IPC, or main-process change.
- Store at most one handoff, keyed to its accepted conversation, and consume it only once.
- Attachment files stay under the accepted `draftConvoId`; never copy or re-pick them.
- A failed dispatch stays on Home with the complete draft and the same retry conversation ID.
- The accepted conversation opens exactly once; completion and consumption actions are idempotent.
- React StrictMode must not erase or double-consume the handoff.
- Preserve Plan 004's diff-review transaction behavior and exact generated review message.

## File map

- Create `src/renderer/src/lib/composerDraft.ts`: renderer-only draft value, content predicate, and
  pure submitted-snapshot subtraction.
- Create `src/renderer/src/components/Composer/useComposerDraft.ts`: atomic React ownership for the
  four user-authored fields.
- Create `src/renderer/src/components/Composer/useComposerDraft.test.tsx`: hook RED/GREEN coverage.
- Modify `src/renderer/src/components/Composer/Composer.tsx`: use the hook and expose accepted and
  initial-handoff callbacks.
- Modify `src/renderer/src/components/Composer/ComposerAttachments.test.tsx`: component contract.
- Modify `src/renderer/src/state/store.ts`: accepted Home owner and one-shot conversation handoff.
- Modify `src/renderer/src/state/store.test.ts`: store lifecycle and retry coverage.
- Modify `src/renderer/src/components/Home.tsx`: complete ownership after Composer subtraction.
- Create `src/renderer/src/components/Home.test.tsx`: Home-to-conversation unmount integration.
- Modify `src/renderer/src/components/ConversationView.tsx`: seed and acknowledge matching handoff.
- Modify `src/renderer/src/components/ConversationView.test.tsx`: matching, one-shot, StrictMode
  coverage.

---

### Task 1: Atomic Composer draft ownership

**Files:**

- Create: `src/renderer/src/lib/composerDraft.ts`
- Create: `src/renderer/src/components/Composer/useComposerDraft.ts`
- Create: `src/renderer/src/components/Composer/useComposerDraft.test.tsx`

**Interfaces:**

- Consumes: `CommandRef`, `MentionRef`, and `PickedAttachmentWire` from `@shared/types`.
- Produces:

```ts
export interface ComposerDraft {
  text: string
  command: CommandRef | null
  mentions: MentionRef[]
  attachments: PickedAttachmentWire[]
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft
export function hasComposerDraftContent(draft: ComposerDraft): boolean
export function subtractSubmittedComposerDraft(
  current: ComposerDraft,
  submitted: ComposerDraft
): ComposerDraft

export function useComposerDraft(initialDraft?: ComposerDraft): {
  draft: ComposerDraft
  snapshot(): ComposerDraft
  setText: React.Dispatch<React.SetStateAction<string>>
  setCommand: React.Dispatch<React.SetStateAction<CommandRef | null>>
  setMentions: React.Dispatch<React.SetStateAction<MentionRef[]>>
  setAttachments: React.Dispatch<React.SetStateAction<PickedAttachmentWire[]>>
  subtractSubmittedSnapshot(submitted: ComposerDraft): ComposerDraft
}
```

- [ ] **Step 1: Write the pure subtraction and hook tests**

Use literal fixtures; never call the production predicate to build expected values.

```tsx
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useComposerDraft } from './useComposerDraft'

it('subtracts only submitted identities and returns the installed remainder', () => {
  const submittedMention = { kind: 'file', name: 'old.ts', path: 'old.ts' } as const
  const lateMention = { kind: 'file', name: 'new.ts', path: 'new.ts' } as const
  const submittedAttachment = {
    ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
    previewDataUrl: 'data:old'
  }
  const lateAttachment = {
    ref: { id: 'new', name: 'new.png', mime: 'image/png', kind: 'image' },
    previewDataUrl: 'data:new'
  }
  const { result } = renderHook(() => useComposerDraft())

  act(() => {
    result.current.setText('submitted')
    result.current.setMentions([submittedMention])
    result.current.setAttachments([submittedAttachment])
  })
  const snapshot = result.current.snapshot()
  act(() => {
    result.current.setText('late text')
    result.current.setMentions((current) => [...current, lateMention])
    result.current.setAttachments((current) => [...current, lateAttachment])
  })

  let remainder
  act(() => {
    remainder = result.current.subtractSubmittedSnapshot(snapshot)
  })

  expect(remainder).toEqual({
    text: 'late text',
    command: null,
    mentions: [lateMention],
    attachments: [lateAttachment]
  })
  expect(result.current.draft).toEqual(remainder)
})
```

Add separate cases for:

- unchanged text/command becoming empty/null;
- a newly selected but value-equal command object surviving by identity;
- `hasComposerDraftContent` returning false for whitespace-only text and true for each non-text
  field;
- an `initialDraft` being cloned into state without later mutating the caller's arrays.

- [ ] **Step 2: Run the hook test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/components/Composer/useComposerDraft.test.tsx
```

Expected: fail because `useComposerDraft` and `composerDraft` do not exist.

- [ ] **Step 3: Implement the pure value**

Create `src/renderer/src/lib/composerDraft.ts`:

```ts
import type { CommandRef, MentionRef, PickedAttachmentWire } from '@shared/types'

export interface ComposerDraft {
  text: string
  command: CommandRef | null
  mentions: MentionRef[]
  attachments: PickedAttachmentWire[]
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: '',
  command: null,
  mentions: [],
  attachments: []
}

export function hasComposerDraftContent(draft: ComposerDraft): boolean {
  return (
    draft.text.trim() !== '' ||
    draft.command !== null ||
    draft.mentions.length > 0 ||
    draft.attachments.length > 0
  )
}

export function subtractSubmittedComposerDraft(
  current: ComposerDraft,
  submitted: ComposerDraft
): ComposerDraft {
  return {
    text: current.text === submitted.text ? '' : current.text,
    command: current.command === submitted.command ? null : current.command,
    mentions: current.mentions.filter((mention) => !submitted.mentions.includes(mention)),
    attachments: current.attachments.filter(
      (attachment) => !submitted.attachments.includes(attachment)
    )
  }
}
```

- [ ] **Step 4: Implement the atomic hook**

Create `useComposerDraft.ts`. All field setters must synchronously update `latestRef` and React
state through one `update` function; do not read/write the ref during render.

```ts
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { CommandRef, MentionRef, PickedAttachmentWire } from '@shared/types'
import {
  EMPTY_COMPOSER_DRAFT,
  subtractSubmittedComposerDraft,
  type ComposerDraft
} from '../../lib/composerDraft'

function resolve<T>(action: SetStateAction<T>, current: T): T {
  return typeof action === 'function'
    ? (action as (value: T) => T)(current)
    : action
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return { ...draft, mentions: [...draft.mentions], attachments: [...draft.attachments] }
}

export function useComposerDraft(initialDraft = EMPTY_COMPOSER_DRAFT): {
  draft: ComposerDraft
  snapshot(): ComposerDraft
  setText: Dispatch<SetStateAction<string>>
  setCommand: Dispatch<SetStateAction<CommandRef | null>>
  setMentions: Dispatch<SetStateAction<MentionRef[]>>
  setAttachments: Dispatch<SetStateAction<PickedAttachmentWire[]>>
  subtractSubmittedSnapshot(submitted: ComposerDraft): ComposerDraft
} {
  const [initial] = useState(() => cloneDraft(initialDraft))
  const latestRef = useRef(initial)
  const [draft, setDraft] = useState(initial)

  const update = useCallback((produce: (current: ComposerDraft) => ComposerDraft): void => {
    const next = produce(latestRef.current)
    latestRef.current = next
    setDraft(next)
  }, [])

  const setText = useCallback<Dispatch<SetStateAction<string>>>(
    (action) => update((current) => ({ ...current, text: resolve(action, current.text) })),
    [update]
  )
  const setCommand = useCallback<Dispatch<SetStateAction<CommandRef | null>>>(
    (action) => update((current) => ({ ...current, command: resolve(action, current.command) })),
    [update]
  )
  const setMentions = useCallback<Dispatch<SetStateAction<MentionRef[]>>>(
    (action) => update((current) => ({ ...current, mentions: resolve(action, current.mentions) })),
    [update]
  )
  const setAttachments = useCallback<Dispatch<SetStateAction<PickedAttachmentWire[]>>>(
    (action) =>
      update((current) => ({ ...current, attachments: resolve(action, current.attachments) })),
    [update]
  )
  const snapshot = useCallback(() => cloneDraft(latestRef.current), [])
  const subtractSubmittedSnapshot = useCallback(
    (submitted: ComposerDraft): ComposerDraft => {
      const next = subtractSubmittedComposerDraft(latestRef.current, submitted)
      latestRef.current = next
      setDraft(next)
      return next
    },
    []
  )

  return {
    draft,
    snapshot,
    setText,
    setCommand,
    setMentions,
    setAttachments,
    subtractSubmittedSnapshot
  }
}
```

- [ ] **Step 5: Run focused tests and lint**

```bash
npx vitest run src/renderer/src/components/Composer/useComposerDraft.test.tsx
npx eslint src/renderer/src/lib/composerDraft.ts \
  src/renderer/src/components/Composer/useComposerDraft.ts \
  src/renderer/src/components/Composer/useComposerDraft.test.tsx
```

Expected: all tests pass and ESLint exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/renderer/src/lib/composerDraft.ts \
  src/renderer/src/components/Composer/useComposerDraft.ts \
  src/renderer/src/components/Composer/useComposerDraft.test.tsx
git commit -m "refactor: isolate composer draft ownership"
```

---

### Task 2: Composer accepted-remainder contract

**Files:**

- Modify: `src/renderer/src/components/Composer/Composer.tsx`
- Modify: `src/renderer/src/components/Composer/ComposerAttachments.test.tsx`

**Interfaces:**

- Consumes: `ComposerDraft` and `useComposerDraft` from Task 1.
- Produces these additions to `ComposerProps`:

```ts
initialDraft?: ComposerDraft
onAccepted?(remainingDraft: ComposerDraft): void
onInitialDraftConsumed?(): void
```

- [ ] **Step 1: Add failing component contract tests**

Extend `ComposerAttachments.test.tsx`:

```tsx
function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it('reports the exact rendered remainder after an accepted pending submit', async () => {
  const pending = deferred<boolean>()
  const onAccepted = vi.fn()
  render(<Composer conversationId="c1" onSend={() => pending.promise} onAccepted={onAccepted} />)

  const textarea = screen.getByRole('textbox')
  fireEvent.change(textarea, { target: { value: 'submitted' } })
  fireEvent.click(screen.getByLabelText('Send'))
  fireEvent.change(textarea, { target: { value: 'late text' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
  fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
  await screen.findByText('shot.png')

  await act(async () => pending.resolve(true))

  expect(onAccepted).toHaveBeenCalledWith({
    text: 'late text',
    command: null,
    mentions: [],
    attachments: [picked.picked[0]]
  })
  expect(textarea).toHaveValue('late text')
  expect(screen.getByText('shot.png')).toBeInTheDocument()
})
```

Add cases proving:

- false never calls `onAccepted`;
- `initialDraft` renders its literal text, command, mention, and attachment;
- `onInitialDraftConsumed` fires exactly once under `<StrictMode>`.

- [ ] **Step 2: Run the Composer test and verify RED**

```bash
npx vitest run src/renderer/src/components/Composer/ComposerAttachments.test.tsx
```

Expected: new props/behavior are absent.

- [ ] **Step 3: Replace the four independent states with the hook**

In `Composer`, initialize:

```ts
const {
  draft,
  snapshot,
  setText: setValue,
  setCommand,
  setMentions,
  setAttachments,
  subtractSubmittedSnapshot
} = useComposerDraft(initialDraft)
const { text: value, command, mentions, attachments } = draft
```

Mechanically route every existing mutation of `value`, `command`, `mentions`, and `attachments`
through these setters. Leave `mentionQuery`, caret, menus, environment, and sending state local.

- [ ] **Step 4: Make accepted subtraction and callback one operation**

Replace submit snapshot/acceptance logic with:

```ts
const sentDraft = snapshot()
const text = sentDraft.text.trim()
const sentAttachments = sentDraft.attachments.map((attachment) => attachment.ref)
// send sentDraft.command and sentDraft.mentions

void onSend(text, sentDraft.command, sentDraft.mentions, sentAttachments).then((accepted) => {
  if (accepted) {
    const remainingDraft = subtractSubmittedSnapshot(sentDraft)
    sendingRef.current = false
    setSending(false)
    onAccepted?.(remainingDraft)
    return
  }
  sendingRef.current = false
  setSending(false)
})
```

Add a one-shot initial claim effect:

```ts
const initialClaimedRef = useRef(false)
useEffect(() => {
  if (!initialDraft || initialClaimedRef.current) return
  initialClaimedRef.current = true
  onInitialDraftConsumed?.()
}, [initialDraft, onInitialDraftConsumed])
```

- [ ] **Step 5: Run Composer regression checks**

```bash
npx vitest run \
  src/renderer/src/components/Composer/useComposerDraft.test.tsx \
  src/renderer/src/components/Composer/ComposerAttachments.test.tsx \
  src/renderer/src/components/Composer/Composer.test.tsx
npm run typecheck:web
npx eslint src/renderer/src/components/Composer/Composer.tsx \
  src/renderer/src/components/Composer/ComposerAttachments.test.tsx
```

Expected: all pass; no duplicate callback or StrictMode draft loss.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/renderer/src/components/Composer/Composer.tsx \
  src/renderer/src/components/Composer/ComposerAttachments.test.tsx
git commit -m "fix: report accepted composer remainder"
```

---

### Task 3: Store the accepted Home owner and one-shot handoff

**Files:**

- Modify: `src/renderer/src/state/store.ts`
- Modify: `src/renderer/src/state/store.test.ts`

**Interfaces:**

- Consumes: `ComposerDraft` and `hasComposerDraftContent` from
  `src/renderer/src/lib/composerDraft.ts`.
- Produces:

```ts
acceptedHomeConvoId: string | null
conversationDraftHandoff: {
  conversationId: string
  draft: ComposerDraft
} | null
completeHomeStart(remainingDraft: ComposerDraft): void
consumeConversationDraftHandoff(conversationId: string): void
```

- [ ] **Step 1: Add failing store lifecycle tests**

Add a focused `describe('Home accepted draft handoff', ...)`:

```ts
it('records acceptance without navigating until Composer transfers ownership', async () => {
  useAppStore.setState({
    view: { kind: 'home' },
    modelRef: 'anthropic/claude-sonnet-5',
    conversations: {},
    draftConvoId: null,
    acceptedHomeConvoId: null,
    conversationDraftHandoff: null
  })

  await expect(useAppStore.getState().startFromHome('submitted')).resolves.toBe(true)

  expect(useAppStore.getState().view).toEqual({ kind: 'home' })
  expect(useAppStore.getState().draftConvoId).toBe('c1')
  expect(useAppStore.getState().acceptedHomeConvoId).toBe('c1')
})
```

Add literal cases for:

- `completeHomeStart` with late text/attachment atomically creating the matching handoff,
  navigating, and clearing both ownership markers;
- empty remainder navigating without a handoff;
- duplicate completion and wrong-conversation consumption being no-ops;
- matching consumption clearing exactly once;
- rejection retaining Home/draft ID with no accepted owner/handoff;
- deleting the target conversation clearing an unconsumed handoff.

- [ ] **Step 2: Run the focused store tests and verify RED**

```bash
npx vitest run src/renderer/src/state/store.test.ts -t 'Home accepted draft handoff'
```

Expected: state/actions are absent and existing start immediately navigates.

- [ ] **Step 3: Add transient state and actions**

Initialize both fields to `null`. On successful `run.start`, replace immediate navigation with:

```ts
set({ acceptedHomeConvoId: convoId })
return true
```

Implement completion:

```ts
completeHomeStart: (remainingDraft) =>
  set((state) => {
    const conversationId = state.acceptedHomeConvoId
    if (!conversationId || !state.conversations[conversationId]) return state
    return {
      view: { kind: 'conversation', id: conversationId },
      draftConvoId: null,
      acceptedHomeConvoId: null,
      conversationDraftHandoff: hasComposerDraftContent(remainingDraft)
        ? { conversationId, draft: remainingDraft }
        : null
    }
  }),
consumeConversationDraftHandoff: (conversationId) =>
  set((state) =>
    state.conversationDraftHandoff?.conversationId === conversationId
      ? { conversationDraftHandoff: null }
      : state
  ),
```

Before a new Home attempt, clear only a stale `acceptedHomeConvoId`; on rejection leave
`draftConvoId` and Home unchanged. Update `goHome` and `deleteConvo` so stale accepted ownership or
matching unconsumed handoffs cannot survive their target.

- [ ] **Step 4: Update older immediate-navigation assertions**

Tests that previously expected `startFromHome` alone to open the conversation must now call:

```ts
useAppStore.getState().completeHomeStart(EMPTY_COMPOSER_DRAFT)
```

Do not weaken their existing assertions about conversation creation, project defaults, attachment
IDs, retry identity, or `run.start` arguments.

- [ ] **Step 5: Run store and static checks**

```bash
npx vitest run src/renderer/src/state/store.test.ts \
  src/renderer/src/state/store.environment.test.ts
npm run typecheck:web
npx eslint src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts
git commit -m "fix: stage accepted home draft ownership"
```

---

### Task 4: Wire Home-to-conversation transfer and prove remount safety

**Files:**

- Modify: `src/renderer/src/components/Home.tsx`
- Create: `src/renderer/src/components/Home.test.tsx`
- Modify: `src/renderer/src/components/ConversationView.tsx`
- Modify: `src/renderer/src/components/ConversationView.test.tsx`

**Interfaces:**

- Consumes all Task 2 Composer props and Task 3 store actions.
- Produces the complete accepted Home-to-conversation data flow; no new public interface.

- [ ] **Step 1: Add a failing Home remount integration**

Create `Home.test.tsx` with real `Home`, `Composer`, and Zustand actions. A small test main-view
harness may render a real conversation Composer after the store changes view; it must not mock
Composer or assert on a mock element.

```tsx
function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function MainViewHarness(): React.JSX.Element {
  const view = useAppStore((state) => state.view)
  const handoff = useAppStore((state) => state.conversationDraftHandoff)
  const consume = useAppStore((state) => state.consumeConversationDraftHandoff)
  if (view.kind === 'home') return <Home />
  return (
    <Composer
      conversationId={view.id}
      initialDraft={handoff?.conversationId === view.id ? handoff.draft : undefined}
      onInitialDraftConsumed={() => consume(view.id)}
      onSend={async () => true}
    />
  )
}
```

Test:

1. Defer `run.start`.
2. Type `submitted`, submit, then type `late text` and pick a literal attachment.
3. Resolve `run.start`.
4. Assert Home unmounts, the conversation Composer shows `late text` and the attachment, and the
   submitted text is absent.
5. Assert the store handoff is consumed.

Add a second case that changes the store view away from Home while `run.start` is pending, then
accepts the run. The initiating Promise continuation must still transfer the latest pre-unmount
draft and open the accepted conversation; it must not strand `acceptedHomeConvoId`.

Expected RED: current Home navigates inside `startFromHome`, so the accepted callback cannot hand
off the late draft.

- [ ] **Step 2: Wire Home completion**

In `Home`:

```tsx
const completeHomeStart = useAppStore((state) => state.completeHomeStart)
// ...
<Composer
  onSend={startFromHome}
  onAccepted={completeHomeStart}
  showEnvRow
  autoFocus
/>
```

- [ ] **Step 3: Add matching ConversationView and StrictMode tests**

In `ConversationView.test.tsx`, render a real matching handoff under `<StrictMode>`:

```tsx
render(
  <StrictMode>
    <ConversationView convoId="c1" />
  </StrictMode>
)
expect(screen.getByRole('textbox')).toHaveValue('late text')
await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())
```

Then unmount/reopen the same conversation and assert the old handoff does not reappear. Add a
different-conversation handoff case proving it is not consumed or rendered.

- [ ] **Step 4: Wire matching initialization and acknowledgment**

In `ConversationView`:

```ts
const initialDraft = useAppStore((state) =>
  state.conversationDraftHandoff?.conversationId === convoId
    ? state.conversationDraftHandoff.draft
    : undefined
)
const consumeDraftHandoff = useAppStore((state) => state.consumeConversationDraftHandoff)
```

Pass:

```tsx
<Composer
  initialDraft={initialDraft}
  onInitialDraftConsumed={() => consumeDraftHandoff(convoId)}
  // existing props unchanged
/>
```

- [ ] **Step 5: Run integration and Plan 004 regression gates**

```bash
npx vitest run \
  src/renderer/src/components/Home.test.tsx \
  src/renderer/src/components/ConversationView.test.tsx \
  src/renderer/src/components/Composer/useComposerDraft.test.tsx \
  src/renderer/src/components/Composer/Composer.test.tsx \
  src/renderer/src/components/Composer/ComposerAttachments.test.tsx \
  src/renderer/src/state/store.test.ts \
  src/renderer/src/components/ArtifactsPane.diff.test.tsx \
  src/renderer/src/components/ArtifactsPane.test.tsx
npm run typecheck:web
npx eslint \
  src/renderer/src/lib/composerDraft.ts \
  src/renderer/src/components/Composer/useComposerDraft.ts \
  src/renderer/src/components/Composer/useComposerDraft.test.tsx \
  src/renderer/src/components/Composer/Composer.tsx \
  src/renderer/src/components/Composer/ComposerAttachments.test.tsx \
  src/renderer/src/components/Home.tsx \
  src/renderer/src/components/Home.test.tsx \
  src/renderer/src/components/ConversationView.tsx \
  src/renderer/src/components/ConversationView.test.tsx \
  src/renderer/src/state/store.ts \
  src/renderer/src/state/store.test.ts
git diff --check
```

Expected: every command exits 0. Existing non-error formatter warnings may be reported, but no
ESLint error or rule suppression is allowed.

- [ ] **Step 6: Run the full web and build gate**

```bash
npm test
npm run build
```

Expected: full suite and build exit 0.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/renderer/src/components/Home.tsx \
  src/renderer/src/components/Home.test.tsx \
  src/renderer/src/components/ConversationView.tsx \
  src/renderer/src/components/ConversationView.test.tsx
git commit -m "fix: hand home drafts to accepted conversations"
```

## Completion checklist

- [ ] Every task has recorded RED and GREEN evidence.
- [ ] Home stays mounted until Composer computes the accepted remainder.
- [ ] Late text, command, mention, and attachment identities survive accepted navigation.
- [ ] Failure retains Home, the complete draft, and retry conversation identity.
- [ ] Empty accepted remainder navigates without creating a handoff.
- [ ] Matching handoff initializes exactly once under StrictMode.
- [ ] Different-conversation handoffs are neither rendered nor consumed.
- [ ] Plan 004 diff-review transactional cases remain green.
- [ ] Focused tests, full suite, typecheck, lint, diff check, and build pass.
