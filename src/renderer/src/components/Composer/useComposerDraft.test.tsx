// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CommandRef, MentionRef, PickedAttachmentWire } from '@shared/types'
import {
  hasComposerDraftContent,
  subtractSubmittedComposerDraft,
  type ComposerDraft
} from '../../lib/composerDraft'
import { useComposerDraft } from './useComposerDraft'

describe('composer drafts', () => {
  it('subtracts only submitted mention and attachment identities', () => {
    const submittedMention: MentionRef = { kind: 'file', name: 'old.ts', path: 'old.ts' }
    const lateMention: MentionRef = { kind: 'file', name: 'new.ts', path: 'new.ts' }
    const submittedAttachment: PickedAttachmentWire = {
      ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:old'
    }
    const lateAttachment: PickedAttachmentWire = {
      ref: { id: 'new', name: 'new.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:new'
    }

    const remainder = subtractSubmittedComposerDraft(
      {
        text: 'late text',
        command: null,
        mentions: [submittedMention, lateMention],
        attachments: [submittedAttachment, lateAttachment]
      },
      {
        text: 'submitted',
        command: null,
        mentions: [submittedMention],
        attachments: [submittedAttachment]
      }
    )

    expect(remainder).toEqual({
      text: 'late text',
      command: null,
      mentions: [lateMention],
      attachments: [lateAttachment]
    })
  })

  it('subtracts only submitted identities and returns the installed remainder', () => {
    const submittedMention: MentionRef = { kind: 'file', name: 'old.ts', path: 'old.ts' }
    const lateMention: MentionRef = { kind: 'file', name: 'new.ts', path: 'new.ts' }
    const submittedAttachment: PickedAttachmentWire = {
      ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:old'
    }
    const lateAttachment: PickedAttachmentWire = {
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

    let remainder: ComposerDraft
    act(() => {
      remainder = result.current.subtractSubmittedSnapshot(snapshot)
    })

    expect(remainder!).toEqual({
      text: 'late text',
      command: null,
      mentions: [lateMention],
      attachments: [lateAttachment]
    })
    expect(result.current.draft).toEqual(remainder!)
  })

  it('clears unchanged text and command from a submitted snapshot', () => {
    const command: CommandRef = { name: 'review', kind: 'workflow' }
    const { result } = renderHook(() => useComposerDraft())

    act(() => {
      result.current.setText('submitted text')
      result.current.setCommand(command)
    })
    const snapshot = result.current.snapshot()

    let remainder: ComposerDraft
    act(() => {
      remainder = result.current.subtractSubmittedSnapshot(snapshot)
    })

    expect(remainder!).toEqual({
      text: '',
      command: null,
      mentions: [],
      attachments: []
    })
  })

  it('keeps a newly selected value-equal command because its identity differs', () => {
    const submittedCommand: CommandRef = { name: 'review', kind: 'workflow' }
    const lateCommand: CommandRef = { name: 'review', kind: 'workflow' }
    const { result } = renderHook(() => useComposerDraft())

    act(() => {
      result.current.setCommand(submittedCommand)
    })
    const snapshot = result.current.snapshot()
    act(() => {
      result.current.setCommand(lateCommand)
    })

    let remainder: ComposerDraft
    act(() => {
      remainder = result.current.subtractSubmittedSnapshot(snapshot)
    })

    expect(remainder!.command).toBe(lateCommand)
    expect(remainder!).toEqual({ text: '', command: lateCommand, mentions: [], attachments: [] })
  })

  it('recognizes meaningful text and every non-text draft field as content', () => {
    const command: CommandRef = { name: 'review', kind: 'workflow' }
    const mention: MentionRef = { kind: 'rule', name: 'Conventions' }
    const attachment: PickedAttachmentWire = {
      ref: { id: 'one', name: 'one.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:one'
    }

    expect(
      hasComposerDraftContent({ text: ' \n\t ', command: null, mentions: [], attachments: [] })
    ).toBe(false)
    expect(
      hasComposerDraftContent({ text: 'message', command: null, mentions: [], attachments: [] })
    ).toBe(true)
    expect(hasComposerDraftContent({ text: '', command, mentions: [], attachments: [] })).toBe(true)
    expect(
      hasComposerDraftContent({ text: '', command: null, mentions: [mention], attachments: [] })
    ).toBe(true)
    expect(
      hasComposerDraftContent({ text: '', command: null, mentions: [], attachments: [attachment] })
    ).toBe(true)
  })

  it('clones initial draft arrays so caller mutations do not change state', () => {
    const initialMention: MentionRef = { kind: 'file', name: 'initial.ts', path: 'initial.ts' }
    const initialAttachment: PickedAttachmentWire = {
      ref: { id: 'initial', name: 'initial.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:initial'
    }
    const callerDraft: ComposerDraft = {
      text: 'initial text',
      command: null,
      mentions: [initialMention],
      attachments: [initialAttachment]
    }
    const { result } = renderHook(() => useComposerDraft(callerDraft))

    callerDraft.mentions.push({ kind: 'rule', name: 'Late rule' })
    callerDraft.attachments.push({
      ref: { id: 'late', name: 'late.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:late'
    })

    expect(result.current.draft.mentions).not.toBe(callerDraft.mentions)
    expect(result.current.draft.attachments).not.toBe(callerDraft.attachments)
    expect(result.current.draft).toEqual({
      text: 'initial text',
      command: null,
      mentions: [initialMention],
      attachments: [initialAttachment]
    })
  })
})
