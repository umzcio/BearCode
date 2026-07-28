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
