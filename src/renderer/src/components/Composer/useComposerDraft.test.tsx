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
    const lateMention: MentionRef = { kind: 'file', name: 'old.ts', path: 'old.ts' }
    const submittedAttachment: PickedAttachmentWire = {
      ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:old'
    }
    const lateAttachment: PickedAttachmentWire = {
      ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:old'
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
    expect(remainder.mentions).not.toContain(submittedMention)
    expect(remainder.mentions[0]).toBe(lateMention)
    expect(remainder.attachments).not.toContain(submittedAttachment)
    expect(remainder.attachments[0]).toBe(lateAttachment)
  })

  it('subtracts only submitted identities and returns the installed remainder', () => {
    const submittedMention: MentionRef = { kind: 'file', name: 'old.ts', path: 'old.ts' }
    const lateMention: MentionRef = { kind: 'file', name: 'old.ts', path: 'old.ts' }
    const submittedAttachment: PickedAttachmentWire = {
      ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:old'
    }
    const lateAttachment: PickedAttachmentWire = {
      ref: { id: 'old', name: 'old.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:old'
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
    expect(result.current.draft.mentions).not.toContain(submittedMention)
    expect(result.current.draft.mentions[0]).toBe(lateMention)
    expect(result.current.draft.attachments).not.toContain(submittedAttachment)
    expect(result.current.draft.attachments[0]).toBe(lateAttachment)
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

  it('clones snapshot arrays while preserving entries and isolating later snapshot mutation', () => {
    const mention: MentionRef = { kind: 'file', name: 'snapshot.ts', path: 'snapshot.ts' }
    const attachment: PickedAttachmentWire = {
      ref: { id: 'snapshot', name: 'snapshot.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:snapshot'
    }
    const { result } = renderHook(() => useComposerDraft())

    act(() => {
      result.current.setMentions([mention])
      result.current.setAttachments([attachment])
    })
    const snapshot = result.current.snapshot()

    expect(snapshot.mentions).not.toBe(result.current.draft.mentions)
    expect(snapshot.attachments).not.toBe(result.current.draft.attachments)
    expect(snapshot.mentions[0]).toBe(mention)
    expect(snapshot.attachments[0]).toBe(attachment)

    snapshot.mentions.push({ kind: 'rule', name: 'Mutated snapshot' })
    snapshot.attachments.push({
      ref: { id: 'mutated', name: 'mutated.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:mutated'
    })

    expect(result.current.draft.mentions).toEqual([mention])
    expect(result.current.draft.mentions[0]).toBe(mention)
    expect(result.current.draft.attachments).toEqual([attachment])
    expect(result.current.draft.attachments[0]).toBe(attachment)
  })

  it('claims every field of a draft supplied after mount when the live draft is empty', () => {
    const command: CommandRef = { name: 'browser', kind: 'builtin' }
    const mention: MentionRef = { kind: 'file', name: 'late.ts', path: 'late.ts' }
    const attachment: PickedAttachmentWire = {
      ref: { id: 'late', name: 'late.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:late'
    }
    const incoming: ComposerDraft = {
      text: 'late text',
      command,
      mentions: [mention],
      attachments: [attachment]
    }
    const { result } = renderHook(() => useComposerDraft())

    let claimed = false
    act(() => {
      claimed = result.current.claimInitialDraftIfEmpty(incoming)
    })

    expect(claimed).toBe(true)
    expect(result.current.draft).toEqual(incoming)
    expect(result.current.draft.mentions).not.toBe(incoming.mentions)
    expect(result.current.draft.attachments).not.toBe(incoming.attachments)
    expect(result.current.draft.command).toBe(command)
    expect(result.current.draft.mentions[0]).toBe(mention)
    expect(result.current.draft.attachments[0]).toBe(attachment)
  })

  it('keeps an incoming draft pending until the live draft becomes empty', () => {
    const incoming: ComposerDraft = {
      text: 'incoming handoff',
      command: null,
      mentions: [],
      attachments: []
    }
    const { result } = renderHook(() => useComposerDraft())

    act(() => result.current.setText('destination edit'))

    let claimed = true
    act(() => {
      claimed = result.current.claimInitialDraftIfEmpty(incoming)
    })
    expect(claimed).toBe(false)
    expect(result.current.draft.text).toBe('destination edit')

    act(() => result.current.setText(''))
    act(() => {
      claimed = result.current.claimInitialDraftIfEmpty(incoming)
    })
    expect(claimed).toBe(true)
    expect(result.current.draft.text).toBe('incoming handoff')
  })
})
