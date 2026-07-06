// Killable child for Office extraction (D5 zip-bomb defence). Bundled as a
// separate main-process entry (electron.vite.config). Receives { mime, bytes }
// via workerData, posts { ok, text } | { ok:false }. The parent terminate()s it
// on timeout.
import { parentPort, workerData } from 'worker_threads'
import { extractOfficeCore } from './office'

async function main(): Promise<void> {
  const { mime, bytes } = workerData as { mime: string; bytes: Buffer }
  try {
    const text = await extractOfficeCore(mime, Buffer.from(bytes))
    parentPort?.postMessage({ ok: true, text })
  } catch {
    parentPort?.postMessage({ ok: false })
  }
}

void main()
