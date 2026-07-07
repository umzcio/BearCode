import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { webmBlobToPcm16k } from './audioToPcm'

// Composer voice input (E5). Captures mic audio in the renderer via getUserMedia
// + MediaRecorder (webm/opus), then hands the audio to main over
// window.bearcode.voice.transcribe, which returns the transcript text. The
// payload depends on the selected STT backend: OpenAI gets the webm bytes
// verbatim; Local gets renderer-decoded 16 kHz mono PCM (Node main can't decode
// Opus, so we decode here via Web Audio). Every failure is non-fatal: it lands
// in `error` and the hook resets to 'idle' so the composer never gets stuck.
export type VoiceStatus = 'idle' | 'recording' | 'transcribing'

export interface UseVoiceRecorder {
  status: VoiceStatus
  error: string | null
  start(): Promise<void>
  stop(): Promise<string | null>
  clearError(): void
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

export function useVoiceRecorder(): UseVoiceRecorder {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const releaseStream = useCallback((): void => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const start = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e): void => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.start()
      recorderRef.current = recorder
      setStatus('recording')
    } catch (err) {
      releaseStream()
      recorderRef.current = null
      setError(messageOf(err) || 'Could not access the microphone.')
      setStatus('idle')
    }
  }, [releaseStream])

  const stop = useCallback(async (): Promise<string | null> => {
    const recorder = recorderRef.current
    if (!recorder) {
      setStatus('idle')
      return null
    }
    setStatus('transcribing')
    let blob: Blob
    try {
      blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = (): void => {
          resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }))
        }
        recorder.stop()
      })
    } finally {
      releaseStream()
      recorderRef.current = null
    }
    try {
      const backend = useAppStore.getState().settings?.sttBackend
      let text: string
      if (backend === 'local') {
        // Decode webm/opus → 16 kHz mono float here; Node main cannot decode it.
        const pcm = await webmBlobToPcm16k(blob)
        const res = await window.bearcode.voice.transcribe(
          pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
          { kind: 'pcm', sampleRate: 16000 }
        )
        text = res.text
      } else {
        const buf = await blob.arrayBuffer()
        const res = await window.bearcode.voice.transcribe(buf, {
          kind: 'webm',
          mimeType: blob.type
        })
        text = res.text
      }
      setStatus('idle')
      return text
    } catch (err) {
      setError(messageOf(err) || 'Transcription failed.')
      setStatus('idle')
      return null
    }
  }, [releaseStream])

  const clearError = useCallback((): void => setError(null), [])

  return { status, error, start, stop, clearError }
}
