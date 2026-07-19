import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invokeSpy, makeModelSpy } = vi.hoisted(() => {
  const invokeSpy = vi.fn()
  const makeModelSpy = vi.fn(() => ({ invoke: invokeSpy }))
  return { invokeSpy, makeModelSpy }
})

vi.mock('./orchestrator/models', () => ({ makeModel: makeModelSpy }))
vi.mock('./db', () => ({
  getConversationMeta: vi.fn(),
  setTitle: vi.fn()
}))

import { maybeGenerateTitle, CHEAP_MODEL } from './title'
import { getConversationMeta, setTitle } from './db'

describe('CHEAP_MODEL', () => {
  it('maps each first-party provider to its cheapest curated model', () => {
    expect(CHEAP_MODEL).toEqual({
      anthropic: 'claude-haiku-4-5',
      openai: 'gpt-5.6-luna',
      google: 'gemini-2.5-flash',
      perplexity: 'sonar',
      xai: 'grok-4-fast'
    })
  })
})

describe('maybeGenerateTitle', () => {
  const onTitle = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when the conversation has no meta', async () => {
    vi.mocked(getConversationMeta).mockReturnValue(undefined as never)
    await maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    expect(makeModelSpy).not.toHaveBeenCalled()
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('does nothing when the conversation is already titled', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: 'Existing' } as never)
    await maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    expect(makeModelSpy).not.toHaveBeenCalled()
  })

  it('calls makeModel with the cheap-model ref and passes an abort signal', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockResolvedValue({ content: 'Fix the login bug' })
    await maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    expect(makeModelSpy).toHaveBeenCalledWith('anthropic/claude-haiku-4-5')
    expect(invokeSpy).toHaveBeenCalledTimes(1)
    const [messages, options] = invokeSpy.mock.calls[0]
    expect(messages).toHaveLength(2)
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to the conversation model when the provider has no cheap entry', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockResolvedValue({ content: 'A title' })
    await maybeGenerateTitle('c1', 'ollama', 'llama3.2', 'hi', 'hello', onTitle)
    expect(makeModelSpy).toHaveBeenCalledWith('ollama/llama3.2')
  })

  it('trims, strips quotes, collapses whitespace, and truncates to 80 chars', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockResolvedValue({ content: `  "${'x'.repeat(90)}"  ` })
    await maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    const title = vi.mocked(setTitle).mock.calls[0][1]
    expect(title.length).toBe(80)
    expect(title.startsWith('"')).toBe(false)
  })

  it('strips markdown decoration and [n] citation markers from a sloppy title', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockResolvedValue({
      content:
        'Zach Rossmiller is the **Associate Vice President**.[2][3]\nSecond line to be dropped.'
    })
    await maybeGenerateTitle('c1', 'perplexity', 'sonar-pro', 'hi', 'hello', onTitle)
    expect(setTitle).toHaveBeenCalledWith(
      'c1',
      'Zach Rossmiller is the Associate Vice President.'
    )
  })

  it('extracts text from a content-block-array response', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockResolvedValue({ content: [{ type: 'text', text: 'Block title' }] })
    await maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    expect(setTitle).toHaveBeenCalledWith('c1', 'Block title')
    expect(onTitle).toHaveBeenCalledWith('c1', 'Block title')
  })

  it('silently skips on empty title text', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockResolvedValue({ content: '   ' })
    await maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    expect(setTitle).not.toHaveBeenCalled()
  })

  it('silently swallows a rejected invoke (e.g. missing key)', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    invokeSpy.mockRejectedValue(new Error('No API key for anthropic. Add it in Settings.'))
    await expect(
      maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    ).resolves.toBeUndefined()
    expect(setTitle).not.toHaveBeenCalled()
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('silently swallows makeModel() itself throwing synchronously', async () => {
    vi.mocked(getConversationMeta).mockReturnValue({ title: null } as never)
    makeModelSpy.mockImplementationOnce(() => {
      throw new Error('No API key for anthropic. Add it in Settings.')
    })
    await expect(
      maybeGenerateTitle('c1', 'anthropic', 'claude-opus-4-8', 'hi', 'hello', onTitle)
    ).resolves.toBeUndefined()
  })
})
