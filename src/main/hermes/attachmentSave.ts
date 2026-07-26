import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { lstat, open, rename, unlink, type FileHandle } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'

const IDENTITY_CHANGED = 'Attachment save file identity changed'

export interface AttachmentSaveDependencies {
  randomName?: () => string
  open?: (path: string, flags: number, mode: number) => Promise<FileHandle>
  write?: (handle: FileHandle, bytes: Buffer, offset: number, length: number) => Promise<number>
  sync?: (handle: FileHandle) => Promise<void>
  rename?: (source: string, destination: string) => Promise<void>
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

async function assertRegularDestination(destination: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(destination)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Save destination must be a regular file')
  }
}

async function assertPathMatchesOwnedFile(
  path: string,
  owned: Awaited<ReturnType<FileHandle['stat']>>
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch {
    throw new Error(IDENTITY_CHANGED)
  }
  if (
    !owned.isFile() ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.dev !== owned.dev ||
    info.ino !== owned.ino ||
    info.size !== owned.size
  ) {
    throw new Error(IDENTITY_CHANGED)
  }
}

async function cleanupOwnedTemporary(
  handle: FileHandle | undefined,
  temporaryPath: string | undefined
): Promise<unknown[]> {
  const failures: unknown[] = []
  if (handle) {
    try {
      await handle.close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (temporaryPath) {
    try {
      await unlink(temporaryPath)
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) failures.push(error)
    }
  }
  return failures
}

export async function saveVerifiedBytes(
  destination: string,
  bytes: Buffer,
  dependencies: AttachmentSaveDependencies = {}
): Promise<void> {
  const absoluteDestination = resolve(destination)
  const parentDirectory = dirname(absoluteDestination)
  const destinationName = basename(absoluteDestination)
  const openFile = dependencies.open ?? open
  const write =
    dependencies.write ??
    (async (handle: FileHandle, buffer: Buffer, offset: number, length: number) => {
      const result = await handle.write(buffer, offset, length, null)
      return result.bytesWritten
    })
  const sync = dependencies.sync ?? ((handle: FileHandle) => handle.sync())
  const replace = dependencies.rename ?? rename
  const randomName = dependencies.randomName ?? randomUUID

  await assertRegularDestination(absoluteDestination)

  let handle: FileHandle | undefined
  let temporaryPath: string | undefined
  while (!handle) {
    const candidate = join(parentDirectory, `.${destinationName}.${randomName()}.bearcode-tmp`)
    try {
      handle = await openFile(
        candidate,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      )
      temporaryPath = candidate
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) continue
      throw error
    }
  }
  if (!temporaryPath) {
    await handle.close()
    throw new Error('Could not create a private attachment file')
  }

  try {
    let offset = 0
    while (offset < bytes.length) {
      const bytesWritten = await write(handle, bytes, offset, bytes.length - offset)
      if (
        !Number.isInteger(bytesWritten) ||
        bytesWritten <= 0 ||
        bytesWritten > bytes.length - offset
      ) {
        throw new Error('Could not write the complete attachment')
      }
      offset += bytesWritten
    }

    await sync(handle)
    const owned = await handle.stat()
    if (!owned.isFile() || owned.size !== bytes.length) {
      throw new Error('Could not write the complete attachment')
    }
    await assertPathMatchesOwnedFile(temporaryPath, owned)
    await assertRegularDestination(absoluteDestination)
    await replace(temporaryPath, absoluteDestination)
    temporaryPath = absoluteDestination
    await assertPathMatchesOwnedFile(absoluteDestination, owned)

    await handle.close()
    handle = undefined
    temporaryPath = undefined
  } catch (error) {
    const cleanupFailures = await cleanupOwnedTemporary(handle, temporaryPath)
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        error instanceof Error ? error.message : 'Attachment save failed'
      )
    }
    throw error
  }
}
