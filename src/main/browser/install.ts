import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { chromium } from 'playwright'

// Playwright resolves its browser under a versioned path; executablePath()
// throws if the browser isn't downloaded yet. Treat a throw OR a missing file
// as "not installed" so first-use can trigger a lazy download.
export function chromiumInstalled(): boolean {
  try {
    const p = chromium.executablePath()
    return !!p && existsSync(p)
  } catch {
    return false
  }
}

// Resolve Playwright's install CLI. `playwright/cli.js` is NOT exposed via the
// package's `exports` map (require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED),
// but `package.json` is always resolvable — cli.js sits beside it.
function playwrightCli(): string {
  const pkg = require.resolve('playwright/package.json')
  return join(dirname(pkg), 'cli.js')
}

// Lazy-download Chromium on first browser use. Playwright's programmatic install
// is `playwright install chromium`; we shell it via the bundled CLI so the
// download progress is observable. Rejects with an actionable message.
export async function ensureChromium(onProgress?: (msg: string) => void): Promise<void> {
  if (chromiumInstalled()) return
  onProgress?.('Downloading the browser engine (one-time, ~150 MB)…')
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    // Run the CLI as plain Node (ELECTRON_RUN_AS_NODE) so it behaves like the
    // documented `playwright install chromium` invocation inside a packaged app.
    const proc = spawn(process.execPath, [playwrightCli(), 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    proc.stdout?.on('data', (d) => onProgress?.(String(d)))
    proc.stderr?.on('data', (d) => onProgress?.(String(d)))
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Browser engine download failed (exit ${code}). Check your network and retry.`
            )
          )
    )
  })
  if (!chromiumInstalled()) throw new Error('Browser engine still missing after download.')
}
