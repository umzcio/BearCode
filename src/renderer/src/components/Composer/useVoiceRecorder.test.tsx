// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceRecorder } from './useVoiceRecorder'

// jsdom ships neither MediaRecorder nor mediaDevices; stub both so the hook's
// capture path is exercisable. The mock recorder emits one chunk and fires
// onstop synchronously on stop().
class MockMediaRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  mimeType = 'audio/webm'
  state = 'inactive'
  constructor(public stream: MediaStream) {}
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['abc'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const trackStop = vi.fn()
const getUserMedia = vi.fn(
  async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream
)
const transcribe = vi.fn(async () => ({ text: 'hello world' }))

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', MockMediaRecorder as unknown as typeof MediaRecorder)
  // Attach onto jsdom's real navigator/window rather than replacing them.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  })
  ;(window as unknown as { bearcode: { voice: { transcribe: typeof transcribe } } }).bearcode = {
    voice: { transcribe }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useVoiceRecorder', () => {
  it('starts recording then transcribes on stop, returning the text', async () => {
    const { result } = renderHook(() => useVoiceRecorder())
    expect(result.current.status).toBe('idle')

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })

    let text: string | null = null
    await act(async () => {
      text = await result.current.stop()
    })
    expect(text).toBe('hello world')
    expect(transcribe).toHaveBeenCalledTimes(1)
    // audio buffer + mime type forwarded to main
    expect(transcribe.mock.calls[0][1]).toBe('audio/webm')
    expect(result.current.status).toBe('idle')
    expect(trackStop).toHaveBeenCalled()
  })

  it('surfaces a getUserMedia denial as a non-fatal error and stays idle', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'))
    const { result } = renderHook(() => useVoiceRecorder())
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBe('Permission denied')
  })

  it('surfaces a transcription failure as a non-fatal error and returns null', async () => {
    transcribe.mockRejectedValueOnce(
      new Error('Add an OpenAI API key in Settings to use voice input.')
    )
    const { result } = renderHook(() => useVoiceRecorder())
    await act(async () => {
      await result.current.start()
    })
    let text: string | null = 'x'
    await act(async () => {
      text = await result.current.stop()
    })
    expect(text).toBeNull()
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBe('Add an OpenAI API key in Settings to use voice input.')
  })

  it('clearError resets the error', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('nope'))
    const { result } = renderHook(() => useVoiceRecorder())
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.error).toBe('nope')
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })
})
