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
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
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
  process.env['BEARCODE_SMOKE_PROMPT'] ??
  'What is the capital of Australia? Answer in one short sentence, and name which model you are.'

// BEARCODE_SMOKE=inspect: dump restored state after a relaunch (Phase 3
// acceptance), open the most recent conversation, and screenshot.
function inspect(win: BrowserWindow): void {
  setTimeout(() => {
    void (async () => {
      try {
        const dump = await win.webContents.executeJavaScript(
          `(async () => {
            const s = window.__bearcodeStore.getState();
            const list = s.convoOrder.map((id) => {
              const c = s.conversations[id];
              return { title: c.title, projectLabel: c.projectLabel, modelRef: c.modelRef };
            });
            if (s.convoOrder.length > 0) {
              s.openConvo(s.convoOrder[0]);
              await new Promise((r) => setTimeout(r, 1200));
              const c = window.__bearcodeStore.getState().conversations[s.convoOrder[0]];
              return JSON.stringify({ list, firstConvoEvents: c.events.map((e) => e.type) }, null, 1);
            }
            return JSON.stringify({ list }, null, 1);
          })()`
        )
        console.log(`[ursa] inspect: ${dump}`)
        const img = await win.webContents.capturePage()
        writeFileSync('/tmp/bearcode-smoke-inspect.png', img.toPNG())
        console.log('[ursa] inspect: saved /tmp/bearcode-smoke-inspect.png')
      } catch (e) {
        console.error('[ursa] inspect failed:', e)
      }
    })()
  }, 4000)
}

let smokeRan = false

export function runDevSmoke(win: BrowserWindow): void {
  // ready-to-show re-fires on renderer reloads (e.g. a dev-server restart);
  // the smoke drill must only ever run once per process.
  if (smokeRan) return
  smokeRan = true
  importKeys()
  const smoke = process.env['BEARCODE_SMOKE']
  if (!smoke) return
  if (smoke === 'inspect') {
    inspect(win)
    return
  }
  const refs = smoke.split(',').map((r) => r.trim())

  const shot = (name: string): Promise<void> =>
    win.webContents.capturePage().then((img) => {
      writeFileSync(`/tmp/bearcode-smoke-${name}.png`, img.toPNG())
      console.log(`[ursa] smoke: saved /tmp/bearcode-smoke-${name}.png`)
    })

  const js = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)

  // BEARCODE_SMOKE_APPROVE=allow|deny answers command-approval pauses.
  const approveMode = process.env['BEARCODE_SMOKE_APPROVE']

  const waitForIdle = async (timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = (await js(
        `(() => {
          const s = window.__bearcodeStore.getState();
          const convo = s.conversations[s.convoOrder[0]];
          return convo ? convo.runState : 'missing';
        })()`
      )) as string
      if (state === 'awaiting-approval' && approveMode) {
        // A brief settle: runState flips to 'awaiting-approval' over IPC a
        // beat before the renderer has painted the PendingCommand card for
        // the same tool_call event, so an immediate capturePage() can race
        // ahead of the paint.
        await new Promise((r) => setTimeout(r, 500))
        await shot('approval-pending')
        const answered = await js(
          `(() => {
            const s = window.__bearcodeStore.getState();
            const convo = s.conversations[s.convoOrder[0]];
            const pending = [...convo.events].reverse().find(
              (e) => e.type === 'tool_call' && e.approvalState === 'pending'
            );
            if (pending) s.approveTool(pending.id, ${JSON.stringify(approveMode === 'allow')});
            return Boolean(pending);
          })()`
        )
        if (answered) {
          console.log(`[ursa] smoke: ${approveMode === 'allow' ? 'approved' : 'denied'} a command`)
        }
      } else if (state !== 'running' && state !== 'missing') {
        return state
      }
      if (Date.now() > deadline) return `timeout (${state})`
      await new Promise((r) => setTimeout(r, 750))
    }
  }

  // Open the review pane on the turn's diff, screenshot it, and verify the
  // write-through files are on disk.
  const reviewAndAccept = async (): Promise<void> => {
    const diffInfo = (await js(
      `(() => {
        const s = window.__bearcodeStore.getState();
        const convo = s.conversations[s.convoOrder[0]];
        const diff = [...convo.events].reverse().find((e) => e.type === 'file_diff');
        return diff ? JSON.stringify({ diffId: diff.diffId, paths: diff.files.map((f) => f.path) }) : null;
      })()`
    )) as string | null
    if (!diffInfo) {
      console.log('[ursa] smoke: no staged diff found')
      return
    }
    const { diffId, paths } = JSON.parse(diffInfo) as { diffId: string; paths: string[] }
    console.log(`[ursa] smoke: staged diff ${diffId}: ${paths.join(', ')}`)
    await js(`window.__bearcodeStore.getState().openReview(${JSON.stringify(diffId)})`)
    await new Promise((r) => setTimeout(r, 3000))
    await shot('review')
    if (process.env['BEARCODE_SMOKE_COMMENT']) {
      // Open the file code tab then trigger a comment composer on line 4.
      await js(
        `(() => {
          const s = window.__bearcodeStore.getState();
          const convo = s.conversations[s.convoOrder[0]];
          const diff = [...convo.events].reverse().find((e) => e.type === 'file_diff');
          if (diff && diff.files[0]) s.openReviewForFile(s.convoOrder[0], diff.files[0].path);
        })()`
      )
      await new Promise((r) => setTimeout(r, 1500))
      await js(
        `(() => {
          const gutters = document.querySelectorAll('.margin-view-overlays .line-numbers');
          const el = gutters[3] || gutters[0];
          if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        })()`
      )
      await new Promise((r) => setTimeout(r, 1200))
      await shot('comment')
    }
    await js(`window.__bearcodeStore.getState().closeReview()`)
    const dir = process.env['BEARCODE_SMOKE_DIR']
    if (dir) {
      for (const p of paths) {
        const abs = join(dir, p)
        const ok = existsSync(abs)
        console.log(
          `[ursa] smoke: on-disk ${p}: ${ok ? `EXISTS (${statSync(abs).size} bytes)` : 'MISSING'}`
        )
      }
    }
    // BEARCODE_SMOKE_REVERT=1: revert the first file and re-check the disk.
    if (process.env['BEARCODE_SMOKE_REVERT'] && dir) {
      await js(
        `(async () => {
          const d = await window.bearcode.diffs.get(${JSON.stringify(diffId)});
          if (d.files[0]) await window.bearcode.diffs.revert(d.files[0].fileId);
        })()`
      )
      const abs = join(dir, paths[0])
      console.log(
        `[ursa] smoke: after revert ${paths[0]}: ${existsSync(abs) ? 'STILL EXISTS' : 'REMOVED'}`
      )
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
        const dir = process.env['BEARCODE_SMOKE_DIR']
        if (dir) {
          await js(`window.__bearcodeStore.setState({ workspacePath: ${JSON.stringify(dir)} })`)
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
                const id = s.convoOrder[0];
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
            const convo = s.conversations[s.convoOrder[0]];
            const turns = [];
            let current = null;
            for (const e of convo.events) {
              if (e.type === 'user_message') { current = { answer: '', model: null, errors: [] }; turns.push(current); }
              else if (!current) continue;
              else if (e.type === 'assistant_text') current.answer = e.text;
              else if (e.type === 'tool_call') current.tools = (current.tools||[]).concat(e.tool);
              else if (e.type === 'turn_meta') current.model = e.provider + '/' + e.model;
              else if (e.type === 'error') current.errors.push(e.message);
            }
            return JSON.stringify({ runState: convo.runState, turns }, null, 1);
          })()`
        )
        console.log(`[ursa] smoke result: ${result}`)
        await reviewAndAccept()
        await shot('final')
      } catch (e) {
        console.error('[ursa] smoke failed:', e)
      }
    })()
  }, 1500)
}
