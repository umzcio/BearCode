// Local (offline) Whisper backend (E5). Runs transformers.js
// automatic-speech-recognition entirely on-device — no API key, no network at
// inference time. The renderer already decoded the recording to 16 kHz mono
// Float32 PCM (Chromium decodes Opus; Node main can't), which is exactly the
// shape the Whisper pipeline consumes, so there's no audio decode here.
//
// The model (~150 MB for whisper-base) downloads from the Hugging Face hub on
// FIRST use only, then caches under the app's userData; subsequent runs are
// offline. The pipeline is built once and memoised in a module-level promise so
// the model loads a single time for the app's lifetime.
import { join } from 'path'
import { app } from 'electron'
import { env, pipeline } from '@xenova/transformers'
import type { AutomaticSpeechRecognitionPipeline } from '@xenova/transformers'

const MODEL_ID = 'Xenova/whisper-base'

let pipePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null

// Build (or reuse) the singleton ASR pipeline. Cache dir points at userData so
// the downloaded model persists across app restarts; remote models are allowed
// so the first run can fetch it.
function getPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!pipePromise) {
    env.cacheDir = join(app.getPath('userData'), 'whisper-cache')
    env.allowRemoteModels = true
    pipePromise = pipeline(
      'automatic-speech-recognition',
      MODEL_ID
    ) as Promise<AutomaticSpeechRecognitionPipeline>
  }
  return pipePromise
}

// `sampleRate` is accepted for interface symmetry with the OpenAI path and to
// document the contract; the renderer always resamples to 16 kHz (Whisper's
// required rate) before sending, so the pipeline receives correctly-rated audio.
export async function transcribeLocal(
  audio: Float32Array,
  _sampleRate: number
): Promise<{ text: string }> {
  const transcriber = await getPipeline()
  const result = await transcriber(audio)
  const text = Array.isArray(result)
    ? result.map((r) => r.text ?? '').join(' ')
    : (result.text ?? '')
  return { text: text.trim() }
}
