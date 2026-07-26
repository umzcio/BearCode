// Marketplace + install logic. A marketplace is a git repo with a root
// marketplace.json listing plugins. Cloning is the ONLY network action and it
// NEVER executes plugin code: shallow, no submodules, git hooks disabled, and a
// protocol allowlist blocks git's RCE-capable transports (ext::/file::/fd::).
import { createHash } from 'crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { git } from '../worktree/git'
import { readFileCapped, isPathWithinRoot } from '../fsCapped'
import { getSettings, setSettings } from '../settings'
import { parsePluginDir } from './manifest'
import { pluginsDir } from './index'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { MarketplacePlugin, PluginManifest, PluginUpdateResult } from '../../shared/types'

const CAP = 256 * 1024
const SAFE_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/

export function assertSafeGitUrl(url: string): void {
  if (typeof url !== 'string' || !SAFE_URL.test(url) || url.startsWith('-'))
    throw new Error(`Refused unsafe git URL: ${String(url)}`)
}

// Turn a URL a human would paste into a cloneable git URL + optional
// branch/subpath. People paste GitHub/GitLab/Bitbucket *web* URLs -- including
// folder links like `.../tree/main/plugins/foo` -- which are NOT git-cloneable
// as-is (git would 404). We rewrite those to `<host>/<owner>/<repo>.git` and
// carry the branch + in-repo subpath separately so the install flow can clone
// the repo and stage just that folder. ssh/git@ URLs and explicit hosts we
// don't recognize pass through unchanged (minus a trailing slash).
export function normalizeGitSource(input: string): {
  cloneUrl: string
  ref?: string
  subpath?: string
} {
  const s = String(input ?? '').trim()
  if (/^(git@|ssh:\/\/)/.test(s)) return { cloneUrl: s }
  const m = s.match(
    /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|src|blob)\/([^/\s]+)(?:\/(.*))?)?\/?$/i
  )
  if (!m) {
    if (/^https:\/\//.test(s)) return { cloneUrl: s.replace(/\/+$/, '') }
    throw new Error(`That is not a git or GitHub URL: ${input}`)
  }
  const [, host, owner, repo, ref, subpath] = m
  return {
    cloneUrl: `https://${host}/${owner}/${repo}.git`,
    ref: ref || undefined,
    subpath: subpath ? subpath.replace(/\/+$/, '') : undefined
  }
}

// Wrap git's raw failure text (which includes the whole clone command line)
// into a short, human message. Callers surface this straight to the UI.
function friendlyGitError(e: unknown, ref?: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Remote branch .* not found|Could not find remote branch/i.test(msg))
    return new Error(`That branch was not found in the repository${ref ? `: ${ref}` : ''}.`)
  if (/not found|does not exist|Could not read from remote|Repository not found/i.test(msg))
    return new Error(
      'Could not find that repository — check the URL is correct and public (or that you have access).'
    )
  if (/Authentication failed|Permission denied|403|401/i.test(msg))
    return new Error(
      'Access denied to that repository — you may need to sign in or use a URL you have access to.'
    )
  return new Error('Could not clone that repository.')
}

const SAFE_ENV = { GIT_ALLOW_PROTOCOL: 'https:ssh:git', GIT_TERMINAL_PROMPT: '0' }
const SAFE_CLONE = [
  '-c',
  'core.hooksPath=/dev/null',
  'clone',
  '--depth',
  '1',
  '--no-recurse-submodules'
]

export async function safeClone(url: string, dest: string, ref?: string): Promise<void> {
  assertSafeGitUrl(url)
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const branchArgs = ref ? ['--branch', ref] : []
  try {
    await git([...SAFE_CLONE, ...branchArgs, url, dest], homedir(), SAFE_ENV)
  } catch (e) {
    rmSync(dest, { recursive: true, force: true })
    throw friendlyGitError(e, ref)
  }
}

// Clone `rawUrl` (normalizing GitHub/GitLab folder URLs) and stage a candidate
// plugin dir under stageRoot(): the whole repo when there's no subpath, or just
// the jailed subpath when the URL points at a folder inside a repo. Returns the
// staged directory path; writes NOTHING into the live plugins tree.
async function cloneAndStage(rawUrl: string): Promise<string> {
  const norm = normalizeGitSource(rawUrl)
  const key = createHash('sha256').update(rawUrl).digest('hex').slice(0, 16)
  const stagePath = join(stageRoot(), key)
  if (existsSync(stagePath)) rmSync(stagePath, { recursive: true, force: true })
  mkdirSync(stageRoot(), { recursive: true })
  if (!norm.subpath) {
    await safeClone(norm.cloneUrl, stagePath, norm.ref)
    return stagePath
  }
  const repoDir = join(stageRoot(), `${key}-repo`)
  await safeClone(norm.cloneUrl, repoDir, norm.ref)
  try {
    const root = resolve(repoDir)
    const resolved = resolve(root, norm.subpath)
    if (!isPathWithinRoot(resolved, root)) throw new Error('That folder path escapes the repository.')
    if (!existsSync(resolved))
      throw new Error(`That folder was not found in the repository: ${norm.subpath}`)
    if (existsSync(stagePath)) rmSync(stagePath, { recursive: true, force: true })
    cpSync(resolved, stagePath, { recursive: true })
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
  return stagePath
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
  // A marketplace is a whole repo (marketplace.json at its root), so ignore any
  // /tree/<branch>/<subpath> a user may have pasted and clone the repo root.
  const { cloneUrl, ref } = normalizeGitSource(url)
  assertSafeGitUrl(cloneUrl)
  await safeClone(cloneUrl, cacheDir(cloneUrl), ref)
  const cur = new Set(listMarketplaces())
  cur.add(cloneUrl)
  setSettings({ marketplaces: [...cur] })
}

export async function removeMarketplace(url: string): Promise<void> {
  const dir = cacheDir(url)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  setSettings({ marketplaces: listMarketplaces().filter((u) => u !== url) })
}

function readManifest(dir: string): { name?: string; plugins?: unknown } | null {
  // Containment: `dir` is the marketplace's own clone root (cacheDir(url)),
  // and marketplace.json is fully attacker-controlled content from a REMOTE,
  // UNTRUSTED repo (this fires for every FEATURED/added marketplace whenever
  // Browse Plugins loads). Without `root`, readFileCapped follows a symlinked
  // marketplace.json straight through to wherever it points -- e.g. the repo
  // ships `marketplace.json -> ~/.ssh/id_rsa` and its contents get parsed and
  // trusted as the catalog. Passing `dir` as `root` makes readFileCapped
  // reject a symlinked leaf outright (see fsCapped.ts) and realpath-check
  // containment, matching the isPathWithinRoot checks already used elsewhere
  // in this file (cloneAndStage's subpath jail, prepareInstall's marketplace
  // subpath jail).
  const r = readFileCapped(join(dir, 'marketplace.json'), CAP, dir)
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
        marketplaceUrl: url,
        kind: e.kind === 'skill' || e.kind === 'plugin' ? e.kind : undefined
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

// ---- Install flow (Task 8) ----
// prepareInstall stages a candidate plugin (clone or marketplace-subpath copy)
// into a scratch dir and parses its manifest -- it writes NOTHING into the
// real plugins dir and never executes anything found there. confirmInstall is
// the only function that copies a staged dir into the live plugins tree, and
// it re-validates the staged manifest's name against COMMAND_NAME_PATTERN
// before using it as the destination folder name (traversal-safe by
// construction, mirrors jailedPluginFolder in index.ts).
export function stageRoot(): string {
  return join(homedir(), '.bearcode', 'plugin-stage')
}

export async function prepareInstall(
  source: string,
  marketplaceUrl?: string
): Promise<{ manifest: PluginManifest; stagePath: string }> {
  let stagePath: string
  if (/^(https:\/\/|ssh:\/\/|git@)/.test(source)) {
    stagePath = await cloneAndStage(source)
  } else if (marketplaceUrl) {
    const root = resolve(cacheDir(marketplaceUrl))
    const resolved = resolve(root, source)
    // Jail the marketplace-declared subpath inside the marketplace's own
    // clone using realpath-based containment (isPathWithinRoot, fsCapped.ts)
    // -- a malicious marketplace.json's `source` is fully marketplace-
    // controlled (parsed straight from marketplace.json by listCatalog, only
    // type-checked as a string) and could otherwise point through a
    // symlinked intermediate directory the repo itself ships, escaping
    // containment even though `resolved` is lexically inside `root`. (A
    // prior fix already replaced a dead self-comparison here with a real
    // resolve()+startsWith check; this replaces THAT check's lexical
    // comparison with a realpath-based one, closing the symlink-following
    // gap the lexical version still had.)
    if (!isPathWithinRoot(resolved, root)) throw new Error('Marketplace plugin path escapes the repo.')
    stagePath = join(
      stageRoot(),
      createHash('sha256')
        .update(root + source)
        .digest('hex')
        .slice(0, 16)
    )
    if (existsSync(stagePath)) rmSync(stagePath, { recursive: true, force: true })
    mkdirSync(stageRoot(), { recursive: true })
    cpSync(resolved, stagePath, { recursive: true })
  } else {
    throw new Error('prepareInstall needs a git URL or a marketplaceUrl + subpath.')
  }
  // Reject symlinks BEFORE the preview parse, not just at confirmInstall.
  // parsePluginDir below reads skills/ and rules/ via readdir-based scans
  // (listSkillFolders/safeReaddir in manifest.ts) that transparently follow a
  // symlinked intermediate directory or file -- and cpSync above (default
  // dereference:false) copies a symlink verbatim into the staged clone, so a
  // malicious plugin repo can ship e.g. `skills -> ~/.ssh` and have its
  // description/name/activation text disclosed to the install PREVIEW, shown
  // to the user before they've confirmed anything. assertNoSymlinks walks the
  // whole staged tree and throws on the first symlink found, so running it
  // here closes the gap for both this preview-stage parse and the later
  // confirmInstall parse (which keeps its own call as defense in depth against
  // the stage directory changing between preview and confirm).
  assertNoSymlinks(stagePath)
  const manifest = parsePluginDir(stagePath, 'global')
  if (!manifest) {
    if (existsSync(join(stagePath, 'marketplace.json')))
      throw new Error(
        'This looks like a marketplace (many plugins), not a single plugin. Add it with “Add marketplace URL” above, then install a plugin from the catalog.'
      )
    throw new Error(
      'No plugin.json found here — this is not a plugin. Point to a repo (or a folder inside one) that contains a plugin.json.'
    )
  }
  return { manifest, stagePath }
}

// Recursively walks a staged plugin tree with lstatSync (which does NOT
// follow symlinks, unlike statSync) and throws on the first symlink found.
// cpSync's default `dereference: false` copies a symlink verbatim rather
// than the file it points to, so a malicious plugin could ship e.g.
// `rules/creds.md -> ~/.aws/credentials`, or `skills`/`rules` itself as a
// symlinked directory; once enabled, readFileCapped (or the readdir-based
// listSkillFolders/safeReaddir scans in manifest.ts) follows the link at load
// time -- a read-side escape of the plugin directory's path-jail. Called from
// BOTH prepareInstall (protects the install PREVIEW parse, which surfaces
// skill/rule text to the renderer before the user has confirmed anything) and
// confirmInstall (protects the copy into the live plugins tree), so no
// symlink is ever followed at either stage.
function assertNoSymlinks(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) {
      throw new Error(`Refused to install: staged plugin contains a symlink (${entry}).`)
    }
    if (st.isDirectory()) assertNoSymlinks(p)
  }
}

export function confirmInstall(stagePath: string): void {
  // Path-jail the SOURCE side too: stagePath must resolve inside stageRoot()
  // (the scratch dir prepareInstall writes into). Without this, a caller
  // could point confirmInstall at an arbitrary directory containing any
  // plugin.json with a valid kebab-case name and have its entire contents
  // copied wholesale into the live plugins tree.
  const rs = resolve(stagePath)
  const sr = resolve(stageRoot())
  if (rs !== sr && !rs.startsWith(sr + sep))
    throw new Error('stagePath must be a previously prepared install stage.')
  assertNoSymlinks(stagePath)
  const manifest = parsePluginDir(stagePath, 'global')
  if (!manifest) throw new Error('Staged directory is not a plugin.')
  if (!COMMAND_NAME_PATTERN.test(manifest.name))
    throw new Error('Plugin name must be kebab-case (traversal rejected).')
  const root = resolve(pluginsDir('global', null))
  const dest = resolve(root, manifest.name)
  // (Same dead-self-comparison fix as prepareInstall above: `dest` was built
  // from `join(root, manifest.name)` and then compared against
  // `join(root, manifest.name)` again, which can never be false. The
  // COMMAND_NAME_PATTERN check just above already rejects traversal
  // characters in manifest.name, but resolve() + containment is kept as the
  // real, structural guard.)
  if (!(dest === root || dest.startsWith(root + sep)))
    throw new Error('Install path escapes the plugins directory.')
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  cpSync(stagePath, dest, { recursive: true })
}

export async function installFromUrl(
  url: string
): Promise<{ manifest: PluginManifest; stagePath: string }> {
  return prepareInstall(url)
}

// A marketplace-subpath install (prepareInstall's cpSync of a repo
// SUBDIRECTORY) carries no `.git`, so `git pull` has nothing to do -- return
// 'not-updatable' rather than silently no-op'ing so the caller (PluginsPage)
// can hide/disable Update instead of offering an action that never does
// anything.
export async function updatePlugin(name: string): Promise<PluginUpdateResult> {
  if (!COMMAND_NAME_PATTERN.test(name)) throw new Error('Invalid plugin name.')
  const dir = join(pluginsDir('global', null), name)
  if (!existsSync(join(dir, '.git'))) return 'not-updatable'
  await git(['-c', 'core.hooksPath=/dev/null', 'pull', '--ff-only'], dir, SAFE_ENV)
  return 'updated'
}
