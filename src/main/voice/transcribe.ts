// Speech-to-text entry point, called from the 'bearcode:voice:transcribe' IPC
// handler (ipc.ts). Runs MAIN-side only so the renderer never holds an API key
// and makes no cross-origin request. V3 implements the real OpenAI Whisper
// backend + `sttBackend` dispatch; this V2 stub only exists so the IPC/preload
// wiring compiles.
export async function transcribe(_audio: Buffer, _mimeType: string): Promise<{ text: string }> {
  throw new Error('not implemented')
}
