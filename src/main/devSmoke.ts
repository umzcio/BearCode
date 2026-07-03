// Dev-only end-to-end smoke test. Launch with BEARCODE_SMOKE=<provider/model>
// (e.g. BEARCODE_SMOKE=ollama/qwen3.5:4b) and the app drives its own renderer
// through a real chat run, then saves a window screenshot for inspection.
// No-op in normal launches and never bundled into behavior users see.
import { writeFileSync } from 'fs'
import type { BrowserWindow } from 'electron'

export function runDevSmoke(win: BrowserWindow): void {
  const modelRef = process.env['BEARCODE_SMOKE']
  if (!modelRef) return

  const shot = (name: string): Promise<void> =>
    win.webContents.capturePage().then((img) => {
      writeFileSync(`/tmp/bearcode-smoke-${name}.png`, img.toPNG())
      console.log(`[ursa] smoke: saved /tmp/bearcode-smoke-${name}.png`)
    })

  const fakeKeyProvider = process.env['BEARCODE_SMOKE_FAKEKEY']
  setTimeout(() => {
    console.log(`[ursa] smoke: starting run with ${modelRef}`)
    void win.webContents
      .executeJavaScript(
        `(async () => {
          const store = window.__bearcodeStore;
          if (!store) return 'no store';
          ${
            fakeKeyProvider
              ? `await store.getState().saveKey(${JSON.stringify(fakeKeyProvider)}, 'sk-bogus-smoke-key');`
              : ''
          }
          store.getState().selectModel(${JSON.stringify(modelRef)});
          store.getState().startFromHome('Reply with exactly: BEARCODE SMOKE OK');
          return 'started';
        })()`
      )
      .then((r) => console.log(`[ursa] smoke: ${r}`))
      .catch((e) => console.error('[ursa] smoke failed:', e))
  }, 3000)

  setTimeout(() => void shot('mid'), 6500)
  setTimeout(() => {
    void win.webContents
      .executeJavaScript(
        `(() => {
          const s = window.__bearcodeStore.getState();
          const convo = Object.values(s.conversations)[0];
          if (!convo) return 'no conversation';
          const texts = convo.events.filter((e) => e.type === 'assistant_text');
          const errors = convo.events.filter((e) => e.type === 'error');
          return JSON.stringify({
            runState: convo.runState,
            eventTypes: convo.events.map((e) => e.type),
            answer: texts.map((t) => t.text).join(''),
            errors: errors.map((e) => e.message)
          });
        })()`
      )
      .then((r) => console.log(`[ursa] smoke result: ${r}`))
      .then(() => shot('final'))
  }, 40000)
}
