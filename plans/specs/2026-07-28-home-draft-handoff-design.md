# Home accepted-draft handoff design

**Status:** Approved; awaiting written-spec review

**Date:** 2026-07-28

## Context

Plan 004 makes Composer submission transactional: `onSend` resolves `true` only after main accepts
`run.start`, and Composer clears only the exact fields included in that accepted submission. Edits
made while the request is pending intentionally remain in Composer.

Home currently changes the application view to the new conversation inside `startFromHome` before
its `Promise<boolean>` resolves. That unmounts Home's Composer before its accepted-snapshot cleanup
can preserve newer text, command, mentions, or attachments. The run is accepted, but the user's
newer draft is lost.

## Goals

- Preserve every Home Composer field added or changed after the submitted snapshot.
- Navigate to the accepted conversation without permitting a second first-run dispatch.
- Keep `startFromHome` on the existing `Promise<boolean>` contract.
- Keep attachment references under the conversation ID already used when they were picked.
- Make the transfer session-only, one-shot, idempotent, and safe under React StrictMode.

## Non-goals

- Persisting drafts across application restarts.
- Adding an IPC method or changing the main-process run contract.
- Changing ordinary ConversationView follow-up submission.
- Retaining transient menu, caret, highlighted-row, or popover state.
- Supporting more than one concurrent Home submission.

## Approaches considered

### 1. One-shot session handoff — selected

After acceptance, Composer computes the fields remaining after subtracting the submitted snapshot.
Home atomically stores that remainder for the accepted conversation and navigates. ConversationView
seeds its Composer from the handoff and acknowledges it once initialization is complete.

This preserves late edits, prevents another Home start, keeps attachment ownership aligned, and
requires no durable storage.

### 2. Stay on Home when a remainder exists

This is mechanically smaller, but leaves an accepted/running conversation behind a still-active
first-run surface. It requires a second policy to prevent duplicate starts and makes the accepted
conversation difficult to discover.

### 3. Disable editing while submission is pending

This avoids the race by forbidding the state that exposes it. It weakens the existing Composer
contract and discards the useful ability to prepare a follow-up while acceptance is pending.

## Design

### Shared draft value

Define a renderer-only `ComposerDraft` value containing:

- `text: string`
- `command: CommandRef | null`
- `mentions: MentionRef[]`
- `attachments: PickedAttachmentWire[]`

The type belongs beside Composer's public props or in a focused renderer-only module imported by
Composer and the store. It must not move into shared IPC types.

Provide a single production `hasComposerDraftContent(draft)` predicate so Home completion and
handoff creation use the same definition of a meaningful remainder. Tests assert literal inputs
and results independently rather than reusing the predicate to construct expectations. The
predicate mirrors Composer's existing content rule: trimmed text, command, mention, or attachment.

### Draft ownership inside Composer

Move the four user-authored fields into a focused `useComposerDraft` unit. It owns:

- the rendered `ComposerDraft` state;
- a synchronized latest-value ref updated only by its event/update helpers, never during render;
- field-level update helpers used by typing, slash commands, mentions, attachments, and removal;
- `subtractSubmittedSnapshot(snapshot)`, which atomically installs and returns the exact remainder.

This avoids deriving the accepted remainder from the stale closure that initiated the Promise and
prevents the rendered state and the handoff callback from computing different values. Transient
menu/caret state remains in Composer and is not part of the hook.

### Composer acceptance callback

Keep:

```ts
onSend(...): Promise<boolean>
```

Add an optional callback for the accepted snapshot:

```ts
onAccepted?(remainingDraft: ComposerDraft): void
```

On `true`, Composer calls `subtractSubmittedSnapshot` against the hook's latest value, removing only
values that still belong to the submitted snapshot:

- Clear text only when it still equals the submitted text value.
- Clear command only when it is the submitted command.
- Remove only submitted mention identities.
- Remove only submitted attachment identities.

The hook atomically updates Composer state and returns that same value to `onAccepted`; there is no
second derivation.

On `false`, Composer changes no draft state and does not call `onAccepted`.

### Home acceptance ownership

`startFromHome` continues to create or reuse `draftConvoId`, configure the conversation, await
`run.start`, and return a boolean. On success it records the accepted conversation ID in transient
store state but does not change `view` or clear `draftConvoId`.

Home supplies `onAccepted` to Composer. The callback invokes one store action:

```ts
completeHomeStart(remainingDraft: ComposerDraft): void
```

That action atomically:

1. Resolves the conversation ID recorded by the accepted Home start.
2. Stores a handoff only when the remainder has meaningful content.
3. Changes `view` to that conversation.
4. Clears `draftConvoId` and the pending accepted-conversation marker.

The action is idempotent. A duplicate callback for an already completed acceptance is a no-op.

The brief interval between `run.start` acceptance and `completeHomeStart` remains protected by
Composer's synchronous `sendingRef`, so Home cannot dispatch a second start.

### Conversation handoff

Store at most one transient value:

```ts
conversationDraftHandoff: {
  conversationId: string
  draft: ComposerDraft
} | null
```

ConversationView reads a handoff only when its `conversationId` matches, passes it to Composer as
`initialDraft`, and acknowledges it only after Composer has synchronously seeded all four draft
fields. Composer then owns the state; clearing the store value cannot clear its local draft.

Acknowledgment must be idempotent and covered under `StrictMode`. A development double mount or
double effect must not cause the second mount to initialize empty. If effect-based acknowledgment
cannot prove that property, retain the matching handoff until Composer explicitly reports its
initialized draft on the committed mount.

Attachments added during the pending request already use `draftConvoId`, which is the accepted
conversation's ID. Their `PickedAttachmentWire` values can therefore move directly into the
conversation Composer without copying files or changing attachment IPC.

## State transitions

### Accepted with no newer draft

1. Home submits snapshot.
2. `run.start` resolves.
3. `startFromHome` records accepted conversation and returns `true`.
4. Composer derives an empty remainder and calls `onAccepted`.
5. Store navigates without creating a handoff.

### Accepted with newer draft

1. Home submits snapshot and remains mounted.
2. User edits one or more draft fields while pending.
3. `run.start` resolves and `startFromHome` returns `true`.
4. Composer derives the exact remainder and calls `onAccepted`.
5. Store writes the matching handoff and navigates atomically.
6. Conversation Composer initializes from the handoff and acknowledges it once.

### Rejected

1. `startFromHome` reports the described error and returns `false`.
2. Home remains selected.
3. Composer retains the submitted snapshot and every later edit.
4. `draftConvoId` remains available for a retry; no handoff exists.

## Error and edge handling

- A completion action without a recorded accepted conversation is a no-op and must not navigate.
- A handoff for a different conversation is never consumed.
- `goHome` clears stale accepted markers and handoffs only when doing so cannot erase an active
  Conversation Composer draft.
- Deleting the target conversation removes its unconsumed handoff.
- If the user explicitly navigates while Home submission is pending, the accepted completion still
  performs the existing ownership transfer and opens the accepted conversation. It must not lose
  the draft simply because the initiating Composer unmounted; its latest-value ref and acceptance
  callback remain the transfer source until the Promise settles.
- Handoff consumption never deletes attachment files.

## Test strategy

### Composer

- Deferred accepted send plus late text preserves only the late text.
- Repeat for command, mentions, and attachments.
- `onAccepted` receives exactly the state rendered after snapshot subtraction.
- False dispatch never calls `onAccepted`.
- Same-tick duplicate submission remains blocked.

### Store and Home

- `startFromHome` acceptance records the conversation without navigating.
- `completeHomeStart` atomically navigates, clears draft ownership, and creates a handoff only for a
  non-empty remainder.
- Failure stays on Home and reuses the same draft conversation ID.
- Duplicate completion is a no-op.

### App integration

- Under a deferred `run.start`, edit the Home draft after submitting; acceptance navigates to the
  conversation and the late draft is visible in its Composer.
- Cover text plus at least one identity-based field (mention or attachment).
- A no-remainder acceptance opens an empty Conversation Composer.
- The handoff is consumed once and does not reappear after leaving and reopening the conversation.
- Run the handoff case under `StrictMode` to prove development remounts do not erase it.

## Acceptance criteria

- No submitted or post-submit Home draft field is lost before or during accepted navigation.
- Failure preserves the complete Home draft and does not navigate.
- The accepted conversation is opened exactly once.
- No second Home run can start during the ownership transfer.
- The handoff is renderer-session-only and consumed by only its matching conversation.
- Existing Plan 004 store, Composer, diff-review, typecheck, and lint gates remain green.
