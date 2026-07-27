// Bounded, stat-gated file read, shared by agentsDir/index.ts and
// mcp/store.ts (security review item 1). Two guarantees:
// 1. Regular files ONLY: stats.isFile() is checked BEFORE any open. This is
//    what keeps a target like a FIFO (open blocks forever when no writer
//    exists), a device node (/dev/zero never ends), or any other non-regular
//    file from hanging or flooding the synchronous main process -- such
//    targets return null, which callers treat as unresolvable.
// 2. The read itself is bounded by a preallocated buffer of at most `cap`
//    bytes filled via fs.readSync on an fd -- never a whole-file
//    readFileSync -- so no unbounded read can occur regardless of what stat
//    reported (a file can grow between stat and read; the buffer bound holds
//    either way).
// Returns null on any error (missing, unreadable, non-regular): callers
// never throw on a bad target. `truncated` reports whether the file held
// more bytes than `cap`.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'fs'
import { basename, dirname, sep } from 'path'

// Resolves symlinks in EVERY path component (not just the leaf) via
// fs.realpathSync and confirms the fully-resolved target still lives inside
// `root`. This is what closes the "symlinked intermediate directory" gap: an
// isSymbolicLink() check on only the leaf file/dir passes when e.g.
// `.cursor/rules` itself is a symlink to somewhere outside the project --
// readdirSync and lstatSync on the leaf both transparently follow that
// intermediate symlink, so only a realpath-based containment check catches
// it. Returns false (never throws) for a missing target, a broken symlink, or
// a permission error -- "cannot prove it's inside root" is treated the same
// as "confirmed outside root": reject.
export function isPathWithinRoot(candidatePath: string, root: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidatePath)
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep)
  } catch {
    return false
  }
}

// Resolve the longest EXISTING prefix of `p` through realpathSync, re-
// appending the not-yet-existing suffix untouched -- so a path whose final
// component(s) don't exist yet still has every EXISTING ancestor -- and
// any symlink among them -- normalized to its real, canonical location
// before any containment check runs. Hoisted here (round3 plan 003) from
// two independently-maintained, byte-identical copies that used to live in
// orchestrator/fsBackend.ts and agentsDir/index.ts -- see those files for
// why they were duplicated rather than cross-imported (a 3-way module
// cycle through orchestrator/tools.ts). fsCapped.ts has zero dependents in
// that cycle, so hosting the shared logic here closes the duplication
// without reintroducing it.
export function realpathExistingPrefix(p: string): string {
  let probe = p
  let suffix = ''
  for (;;) {
    try {
      probe = realpathSync(probe)
      break
    } catch {
      suffix = sep + basename(probe) + suffix
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return probe + suffix
}

export function readFileCapped(
  path: string,
  cap: number,
  root?: string
): { text: string; truncated: boolean } | null {
  let fd: number
  try {
    const lstat = lstatSync(path)
    // Opt-in, gated the same way as the isPathWithinRoot check just below:
    // only reject a symlinked leaf when a caller passes `root` (config-import
    // scanning). Every other call site (agentsDir/index.ts, agentsDir/memory.ts,
    // hooks/loader.ts, plugins/manifest.ts, plugins/marketplace.ts) never
    // passes `root` and relies on the pre-existing "symlinks are followed"
    // behavior -- e.g. a dotfiles-managed ~/.bearcode/agents/rules/foo.md
    // symlink must keep working. When `root` IS provided, this leaf check is
    // technically redundant with isPathWithinRoot (realpathSync resolves the
    // whole chain including the leaf) but kept for clarity/defense-in-depth.
    if (root && lstat.isSymbolicLink()) return null
    // Optional, opt-in: callers that know the path was derived from a scan of
    // untrusted repo content (config-import) pass their project root here so
    // an intermediate-directory symlink escape is caught too, not just a
    // symlinked leaf (security review follow-up on the config-import scan
    // fix -- leaf-only checks left `.cursor/rules` (etc) itself being a
    // symlink undetected).
    if (root && !isPathWithinRoot(path, root)) return null
    // O_NOFOLLOW is opt-in, gated on `root` -- exactly the same discipline as
    // the leaf-symlink check just above. Callers that never pass `root` (the
    // ~12 non-config-import call sites) must keep transparently following a
    // symlinked leaf (e.g. a dotfiles-managed ~/.bearcode/agents/rules/foo.md
    // symlink), so they get the plain O_RDONLY open, identical to the
    // previous `openSync(path, 'r')`. When `root` IS provided, O_NOFOLLOW
    // closes the TOCTOU race window between the lstat/isPathWithinRoot
    // checks above and this open: even if a symlink is swapped onto `path`
    // in between, the open itself fails (ELOOP) instead of transparently
    // following it. Mirrors hermes/nativeFiles.ts's
    // describeNativeUpload/openAttachment pattern (open with O_NOFOLLOW,
    // then fstat the DESCRIPTOR below, never the pathname again).
    fd = openSync(path, root ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY)
  } catch {
    return null
  }
  try {
    // fstat the OPEN DESCRIPTOR, not the pathname -- whatever currently sits
    // at `path` on disk is irrelevant from this point on; only the inode
    // this fd already points to matters, which is what closes the race.
    const stats = fstatSync(fd)
    if (!stats.isFile()) return null
    const size = stats.size
    const toRead = Math.min(size, cap)
    const buf = Buffer.alloc(toRead)
    let offset = 0
    while (offset < toRead) {
      const n = readSync(fd, buf, offset, toRead - offset, offset)
      if (n === 0) break
      offset += n
    }
    return { text: buf.toString('utf8', 0, offset), truncated: size > cap }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
