// Speech-to-text entry point, called from the 'bearcode:voice:transcribe' IPC
// handler (ipc.ts). Runs MAIN-side only so the renderer never holds an API key
// and makes no cross-origin request. Dispatches on the `sttBackend` setting:
// 'local' → on-device Whisper (V6; not available yet), else OpenAI Whisper.
import { getKey } from '../keys'
import { getSettings } from '../settings'

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'

// POST the recorded audio to OpenAI's Whisper endpoint as multipart/form-data.
// The API key is read main-side via getKey and never leaves this process.
export async function transcribeOpenAI(audio: Buffer, mimeType: string): Promise<{ text: string }> {
  const key = getKey('openai')
  if (!key) {
    throw new Error('Add an OpenAI API key in Settings to use voice input.')
  }

  const form = new FormData()
  form.append('file', new Blob([audio], { type: mimeType }), 'audio.webm')
  form.append('model', 'whisper-1')

  const res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form
  })

  if (!res.ok) {
    throw new Error(`OpenAI transcription failed (${res.status})`)
  }

  const data = (await res.json()) as { text?: string }
  return { text: data.text ?? '' }
}

export async function transcribe(audio: Buffer, mimeType: string): Promise<{ text: string }> {
  const backend = getSettings().sttBackend
  if (backend === 'local') {
    throw new Error("Local transcription isn't available yet — use OpenAI Whisper in Settings.")
  }
  return transcribeOpenAI(audio, mimeType)
}
