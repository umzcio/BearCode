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
import { closeSync, openSync, readSync, statSync } from 'fs'

export function readFileCapped(
  path: string,
  cap: number
): { text: string; truncated: boolean } | null {
  let fd: number
  let size: number
  try {
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
