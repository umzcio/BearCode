// Conversation title generation (spec 6.4): after the first completed turn,
// a background call to the cheapest available model from the current
// provider names the conversation. Failures are silent; the sidebar keeps
// the first-message fallback.
import { generateText } from 'ai'
import type { ProviderId } from '../../shared/types'
import { getProvider } from './providers/registry'
import { getConversationMeta, setTitle } from '../db'

// Cheapest curated model per provider; Ollama and OpenRouter reuse the
// model already in play rather than assuming what else is available.
const CHEAP_MODEL: Partial<Record<ProviderId, string>> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  google: 'gemini-2.5-flash'
}

export async function maybeGenerateTitle(
  conversationId: string,
  providerId: ProviderId,
  modelId: string,
  userText: string,
  answerText: string,
  onTitle: (conversationId: string, title: string) => void
): Promise<void> {
  const meta = getConversationMeta(conversationId)
  if (!meta || meta.title) return

  try {
    const provider = getProvider(providerId)
    const cheapId = CHEAP_MODEL[providerId] ?? modelId
    const { text } = await generateText({
      model: provider.make(cheapId),
      system:
        'Generate a 3 to 6 word title for this conversation. ' +
        'Reply with only the title: no quotes, no punctuation at the end.',
      messages: [
        {
          role: 'user',
          content: `User asked: ${userText.slice(0, 500)}\n\nAssistant replied: ${answerText.slice(0, 500)}`
        }
      ],
      // Generous ceiling: local thinking models reason before titling.
      abortSignal: AbortSignal.timeout(60000)
    })
    const title = text
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
    if (!title) return
    setTitle(conversationId, title)
    onTitle(conversationId, title)
  } catch (err) {
    console.log(
      `[ursa] title generation skipped (${providerId}):`,
      err instanceof Error ? err.message : err
    )
  }
}
