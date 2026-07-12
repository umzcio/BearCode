// Marketplace + install logic. A marketplace is a git repo with a root
// marketplace.json listing plugins. Cloning is the ONLY network action and it
// NEVER executes plugin code: shallow, no submodules, git hooks disabled, and a
// protocol allowlist blocks git's RCE-capable transports (ext::/file::/fd::).
import { createHash } from 'crypto'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { git } from '../worktree/git'
import { readFileCapped } from '../fsCapped'
import { getSettings, setSettings } from '../settings'
import type { MarketplacePlugin } from '../../shared/types'

const CAP = 256 * 1024
const SAFE_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/

export function assertSafeGitUrl(url: string): void {
  if (typeof url !== 'string' || !SAFE_URL.test(url) || url.startsWith('-'))
    throw new Error(`Refused unsafe git URL: ${String(url)}`)
}

const SAFE_ENV = { GIT_ALLOW_PROTOCOL: 'https:ssh:git', GIT_TERMINAL_PROMPT: '0' }
const SAFE_CLONE = ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--no-recurse-submodules']

export async function safeClone(url: string, dest: string): Promise<void> {
  assertSafeGitUrl(url)
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  await git([...SAFE_CLONE, url, dest], homedir(), SAFE_ENV)
}

function marketplacesRoot(): string {
  return join(homedir(), '.bearcode', 'marketplaces')
}
function cacheDir(url: string): string {
  return join(marketplacesRoot(), createHash('sha256').update(url).digest('hex').slice(0, 16))
}

export function listMarketplaces(): string[] {
  return getSettings().marketplaces ?? []
}

export async function addMarketplace(url: string): Promise<void> {
  assertSafeGitUrl(url)
  await safeClone(url, cacheDir(url))
  const cur = new Set(listMarketplaces())
  cur.add(url)
  setSettings({ marketplaces: [...cur] })
}

export async function removeMarketplace(url: string): Promise<void> {
  const dir = cacheDir(url)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  setSettings({ marketplaces: listMarketplaces().filter((u) => u !== url) })
}

function readManifest(dir: string): { name?: string; plugins?: unknown } | null {
  const r = readFileCapped(join(dir, 'marketplace.json'), CAP)
  if (!r) return null
  try {
    const v = JSON.parse(r.text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export async function listCatalog(): Promise<MarketplacePlugin[]> {
  const out: MarketplacePlugin[] = []
  for (const url of [...FEATURED, ...listMarketplaces()]) {
    const dir = cacheDir(url)
    if (!existsSync(dir)) {
      try {
        await safeClone(url, dir)
      } catch {
        continue
      }
    }
    const man = readManifest(dir)
    if (!man || !Array.isArray(man.plugins)) continue
    for (const p of man.plugins) {
      if (!p || typeof p !== 'object') continue
      const e = p as Record<string, unknown>
      if (typeof e.name !== 'string' || typeof e.source !== 'string') continue
      out.push({
        name: e.name,
        description: typeof e.description === 'string' ? e.description : '',
        source: e.source,
        marketplaceUrl: url
      })
    }
  }
  // de-dupe by name+marketplace
  const seen = new Set<string>()
  return out.filter((p) => {
    const k = `${p.marketplaceUrl}#${p.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// Baked-in featured marketplace. If it 404s/empties, listCatalog degrades to []
// for it (the try/catch above). Zach to create this repo; safe if it does not exist yet.
export const FEATURED: string[] = ['https://github.com/umzcio/bearcode-plugins']
