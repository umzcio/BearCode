import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { CommandRef, MentionRef, PickedAttachmentWire } from '@shared/types'
import {
  EMPTY_COMPOSER_DRAFT,
  subtractSubmittedComposerDraft,
  type ComposerDraft
} from '../../lib/composerDraft'

function resolve<T>(action: SetStateAction<T>, current: T): T {
  return typeof action === 'function' ? (action as (value: T) => T)(current) : action
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
  const subtractSubmittedSnapshot = useCallback((submitted: ComposerDraft): ComposerDraft => {
    const next = subtractSubmittedComposerDraft(latestRef.current, submitted)
    latestRef.current = next
    setDraft(next)
    return next
  }, [])

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
