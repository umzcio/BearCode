// Renderer-side audio decode for the Local Whisper backend (E5). MediaRecorder
// captures webm/opus, which Node main cannot decode — but Chromium can. So we
// decode the recorded Blob here via Web Audio, resample to the 16 kHz mono
// Float32 PCM that transformers.js Whisper expects, and hand main just the raw
// samples. The OpenAI path never calls this (it sends the webm bytes verbatim).

const WHISPER_SAMPLE_RATE = 16000

// Some environments prefix AudioContext; grab whichever exists at call time.
function getAudioContextCtor(): typeof AudioContext {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) throw new Error('Web Audio API is not available in this environment.')
  return Ctor
}

// Decode `blob` (webm/opus) to a mono Float32Array resampled to 16 kHz.
// OfflineAudioContext(1, ...) forces a single output channel, so Whisper gets
// mono regardless of how many channels were captured.
export async function webmBlobToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer()

  const DecodeCtx = getAudioContextCtor()
  const decodeCtx = new DecodeCtx()
  let decoded: AudioBuffer
  try {
    // decodeAudioData detaches the buffer; pass a copy so callers can reuse it.
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    void decodeCtx.close()
  }

  const frameCount = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE)
  if (frameCount <= 0) return new Float32Array(0)

  const offline = new OfflineAudioContext(1, frameCount, WHISPER_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)

  const rendered = await offline.startRendering()
  // Channel 0 of the mono render is the resampled PCM Whisper consumes.
  return rendered.getChannelData(0)
}
