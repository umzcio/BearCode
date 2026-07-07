// Speech-to-text entry point, called from the 'bearcode:voice:transcribe' IPC
// handler (ipc.ts). Runs MAIN-side only so the renderer never holds an API key
// and makes no cross-origin request. Dispatches on the payload's `meta.kind`,
// which the renderer already set from the `sttBackend` setting: a 'pcm' payload
// (renderer-decoded 16 kHz mono float) ALWAYS goes to the local engine, a
// 'webm' payload (raw container bytes) ALWAYS goes to OpenAI. Routing on the
// payload shape (not re-reading the setting) guarantees each backend only ever
// receives audio it can actually read.
import type { TranscribeMeta } from '../../shared/types'
import { getKey } from '../keys'
import { transcribeLocal } from './transcribeLocal'

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

export async function transcribe(
  audio: ArrayBuffer,
  meta: TranscribeMeta
): Promise<{ text: string }> {
  if (meta.kind === 'pcm') {
    return transcribeLocal(new Float32Array(audio), meta.sampleRate)
  }
  return transcribeOpenAI(Buffer.from(audio), meta.mimeType)
}
