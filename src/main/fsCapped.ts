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
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'fs'
import { sep } from 'path'

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

export function readFileCapped(
  path: string,
  cap: number,
  root?: string
): { text: string; truncated: boolean } | null {
  let fd: number
  let size: number
  try {
    const lstat = lstatSync(path)
    if (lstat.isSymbolicLink()) return null
    // Optional, opt-in: callers that know the path was derived from a scan of
    // untrusted repo content (config-import) pass their project root here so
    // an intermediate-directory symlink escape is caught too, not just a
    // symlinked leaf (security review follow-up on the config-import scan
    // fix -- leaf-only checks left `.cursor/rules` (etc) itself being a
    // symlink undetected).
    if (root && !isPathWithinRoot(path, root)) return null
    const stats = statSync(path)
    if (!stats.isFile()) return null
    size = stats.size
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
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
