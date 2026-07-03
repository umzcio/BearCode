// Dev-only end-to-end smoke test, never part of user-facing behavior.
//
//   BEARCODE_SMOKE=<provider/model>[,<provider/model>...]
//     Drives the renderer through a real chat run. With multiple refs, asks
//     the same question once per model in ONE conversation, switching models
//     between turns (the Phase 2 acceptance drill). Saves screenshots and
//     logs the event stream summary.
//   BEARCODE_SMOKE_FAKEKEY=<provider>
//     Stores a bogus key for that provider first (error-path test).
//   BEARCODE_IMPORT_KEYS=<path to .env>
//     Imports provider API keys from an env file into the vault, main-side,
//     so key values never appear in logs. Runs even without BEARCODE_SMOKE.
import { readFileSync, writeFileSync } from 'fs'
import type { BrowserWindow } from 'electron'
import type { ProviderId } from '../shared/types'
import { setKey } from './keys'

const ENV_TO_PROVIDER: Record<string, ProviderId> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GOOGLE_API_KEY: 'google',
  GEMINI_API_KEY: 'google',
  OPENROUTER_API_KEY: 'openrouter'
}

function importKeys(): void {
  const file = process.env['BEARCODE_IMPORT_KEYS']
  if (!file) return
  const imported: string[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"\s]+)"?\s*$/)
    if (!m) continue
    const provider = ENV_TO_PROVIDER[m[1]]
    if (provider && m[2]) {
      setKey(provider, m[2])
      imported.push(provider)
    }
  }
  console.log(`[ursa] smoke: imported keys for: ${imported.join(', ') || 'none'}`)
}

const QUESTION =
  'What is the capital of Australia? Answer in one short sentence, and name which model you are.'

export function runDevSmoke(win: BrowserWindow): void {
  importKeys()
  const smoke = process.env['BEARCODE_SMOKE']
  if (!smoke) return
  const refs = smoke.split(',').map((r) => r.trim())

  const shot = (name: string): Promise<void> =>
    win.webContents.capturePage().then((img) => {
      writeFileSync(`/tmp/bearcode-smoke-${name}.png`, img.toPNG())
      console.log(`[ursa] smoke: saved /tmp/bearcode-smoke-${name}.png`)
    })

  const js = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)

  const waitForIdle = async (timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = (await js(
        `(() => {
          const s = window.__bearcodeStore.getState();
          const convo = Object.values(s.conversations)[0];
          return convo ? convo.runState : 'missing';
        })()`
      )) as string
      if (state !== 'running' && state !== 'missing') return state
      if (Date.now() > deadline) return `timeout (${state})`
      await new Promise((r) => setTimeout(r, 750))
    }
  }

  const fakeKeyProvider = process.env['BEARCODE_SMOKE_FAKEKEY']

  setTimeout(() => {
    void (async () => {
      try {
        // Let the renderer load settings and providers.
        await new Promise((r) => setTimeout(r, 2500))
        if (fakeKeyProvider) {
          await js(
            `window.__bearcodeStore.getState().saveKey(${JSON.stringify(fakeKeyProvider)}, 'sk-bogus-smoke-key')`
          )
        }
        await js(`window.__bearcodeStore.getState().refreshProviders()`)
        await new Promise((r) => setTimeout(r, 1000))

        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i]
          console.log(`[ursa] smoke: turn ${i + 1}/${refs.length} on ${ref}`)
          await js(`window.__bearcodeStore.getState().selectModel(${JSON.stringify(ref)})`)
          if (i === 0) {
            await js(`window.__bearcodeStore.getState().startFromHome(${JSON.stringify(QUESTION)})`)
          } else {
            await js(
              `(() => {
                const s = window.__bearcodeStore.getState();
                const id = Object.keys(s.conversations)[0];
                s.send(id, ${JSON.stringify(QUESTION)});
              })()`
            )
          }
          await new Promise((r) => setTimeout(r, 1500))
          const state = await waitForIdle(90000)
          console.log(`[ursa] smoke: turn ${i + 1} finished with state: ${state}`)
          await shot(`turn-${i + 1}`)
        }

        const result = await js(
          `(() => {
            const s = window.__bearcodeStore.getState();
            const convo = Object.values(s.conversations)[0];
            const turns = [];
            let current = null;
            for (const e of convo.events) {
              if (e.type === 'user_message') { current = { answer: '', model: null, errors: [] }; turns.push(current); }
              else if (!current) continue;
              else if (e.type === 'assistant_text') current.answer = e.text;
              else if (e.type === 'turn_meta') current.model = e.provider + '/' + e.model;
              else if (e.type === 'error') current.errors.push(e.message);
            }
            return JSON.stringify({ runState: convo.runState, turns }, null, 1);
          })()`
        )
        console.log(`[ursa] smoke result: ${result}`)
        await shot('final')
      } catch (e) {
        console.error('[ursa] smoke failed:', e)
      }
    })()
  }, 1500)
}
