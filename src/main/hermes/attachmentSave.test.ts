import { constants } from 'fs'
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveVerifiedBytes, type AttachmentSaveDependencies } from './attachmentSave'

const temporaryDirectories: string[] = []

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bearcode-attachment-save-'))
  temporaryDirectories.push(directory)
  return directory
}

async function temporarySiblings(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.bearcode-tmp'))
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('saveVerifiedBytes', () => {
  it('saves byte-identical content to a private new destination', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.bin')
    const bytes = Buffer.from([0, 255, 17, 99, 128])

    await saveVerifiedBytes(destination, bytes)

    expect(await readFile(destination)).toEqual(bytes)
    expect((await lstat(destination)).mode & 0o777).toBe(0o600)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('keeps an existing destination unchanged until the atomic replacement', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.txt')
    const original = Buffer.from('original destination')
    const replacement = Buffer.from('complete verified replacement')
    await writeFile(destination, original)
    let contentBeforeRename: Buffer | undefined

    await saveVerifiedBytes(destination, replacement, {
      rename: async (source, target) => {
        contentBeforeRename = await readFile(target)
        await rename(source, target)
      }
    })

    expect(contentBeforeRename).toEqual(original)
    expect(await readFile(destination)).toEqual(replacement)
    expect((await lstat(destination)).mode & 0o777).toBe(0o600)
  })

  it('rejects a destination symlink without altering its target', async () => {
    const directory = await makeTemporaryDirectory()
    const target = join(directory, 'target.txt')
    const destination = join(directory, 'report.txt')
    const original = Buffer.from('do not replace through a link')
    await writeFile(target, original)
    await symlink(target, destination)

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'))
    ).rejects.toThrow('regular file')

    expect(await readFile(target)).toEqual(original)
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('retries a colliding temporary name without deleting the existing sibling', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.txt')
    const collision = join(directory, '.report.txt.collision.bearcode-tmp')
    await writeFile(collision, 'someone else owns this file')
    const randomNames = ['collision', 'available']

    await saveVerifiedBytes(destination, Buffer.from('verified bytes'), {
      randomName: () => randomNames.shift() ?? 'unexpected'
    })

    expect(await readFile(destination, 'utf8')).toBe('verified bytes')
    expect(await readFile(collision, 'utf8')).toBe('someone else owns this file')
    expect(await temporarySiblings(directory)).toEqual(['.report.txt.collision.bearcode-tmp'])
  })

  it('writes the complete buffer when the filesystem accepts short writes', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.bin')
    const bytes = Buffer.from('the whole immutable verified buffer')

    await saveVerifiedBytes(destination, bytes, {
      write: async (handle, buffer, offset, length) => {
        const result = await handle.write(buffer, offset, Math.min(length, 3), null)
        return result.bytesWritten
      }
    })

    expect(await readFile(destination)).toEqual(bytes)
  })

  it.each(['write', 'sync', 'rename'] as const)(
    'removes the private sibling and leaves no partial destination when %s fails',
    async (operation) => {
      const directory = await makeTemporaryDirectory()
      const destination = join(directory, 'report.bin')
      const dependencies: AttachmentSaveDependencies =
        operation === 'write'
          ? {
              write: async () => {
                throw new Error('injected write failure')
              }
            }
          : operation === 'sync'
            ? {
                sync: async () => {
                  throw new Error('injected sync failure')
                }
              }
            : {
                rename: async () => {
                  throw new Error('injected rename failure')
                }
              }

      await expect(
        saveVerifiedBytes(destination, Buffer.from('verified bytes'), dependencies)
      ).rejects.toThrow(`injected ${operation} failure`)

      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await temporarySiblings(directory)).toEqual([])
    }
  )

  it('rejects a destination changed to a symlink after the temporary file is synced', async () => {
    const directory = await makeTemporaryDirectory()
    const target = join(directory, 'target.txt')
    const destination = join(directory, 'report.txt')
    const originalTarget = Buffer.from('target stays untouched')
    await writeFile(target, originalTarget)
    await writeFile(destination, 'original destination')

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'), {
        sync: async (handle) => {
          await handle.sync()
          await unlink(destination)
          await symlink(target, destination)
        }
      })
    ).rejects.toThrow('regular file')

    expect(await readFile(target)).toEqual(originalTarget)
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('rejects without unlinking a temporary path replaced with a symlink before rename', async () => {
    const directory = await makeTemporaryDirectory()
    const attackerTarget = join(directory, 'attacker-target.txt')
    const destination = join(directory, 'report.txt')
    const attackerBytes = Buffer.from('attacker-controlled bytes')
    await writeFile(attackerTarget, attackerBytes)

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'), {
        rename: async (source, target) => {
          await unlink(source)
          await symlink(attackerTarget, source)
          await rename(source, target)
        }
      })
    ).rejects.toThrow('Attachment save file identity changed')

    expect(await readFile(attackerTarget)).toEqual(attackerBytes)
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('does not unlink a non-owned destination after a post-rename identity mismatch', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.txt')
    const outsiderBytes = Buffer.from('new path owner bytes')
    await writeFile(destination, 'original destination')

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'), {
        rename: async (source, target) => {
          await rename(source, target)
          await unlink(target)
          await writeFile(target, outsiderBytes)
        }
      })
    ).rejects.toThrow('Attachment save file identity changed')

    expect(await readFile(destination)).toEqual(outsiderBytes)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('does not unlink a substituted temporary source before preserving an existing destination', async () => {
    const directory = await makeTemporaryDirectory()
    const attackerTarget = join(directory, 'attacker-target.txt')
    const destination = join(directory, 'report.txt')
    const originalDestination = Buffer.from('preserve this destination')
    const attackerBytes = Buffer.from('attacker-controlled bytes')
    await writeFile(attackerTarget, attackerBytes)
    await writeFile(destination, originalDestination)

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'), {
        sync: async (handle) => {
          await handle.sync()
          const [temporaryName] = await temporarySiblings(directory)
          if (!temporaryName) throw new Error('private temporary file was not created')
          const temporaryPath = join(directory, temporaryName)
          await unlink(temporaryPath)
          await symlink(attackerTarget, temporaryPath)
        }
      })
    ).rejects.toThrow('Attachment save file identity changed')

    expect(await readFile(destination)).toEqual(originalDestination)
    expect(await readFile(attackerTarget)).toEqual(attackerBytes)
    const [substitutedName] = await temporarySiblings(directory)
    expect(substitutedName).toBeTruthy()
    expect((await lstat(join(directory, substitutedName!))).isSymbolicLink()).toBe(true)
  })

  it('keeps a successfully renamed destination when descriptor close reports failure', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.txt')
    const replacement = Buffer.from('complete verified replacement')
    await writeFile(destination, 'original destination')

    await expect(
      saveVerifiedBytes(destination, replacement, {
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode)
          const close = handle.close.bind(handle)
          let closeAttempts = 0
          handle.close = async () => {
            closeAttempts += 1
            if (closeAttempts === 1) {
              await close()
              throw new Error('injected close failure')
            }
          }
          return handle
        }
      })
    ).rejects.toThrow('injected close failure')

    expect(await readFile(destination)).toEqual(replacement)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('creates the private sibling with exclusive no-follow flags and mode 0600', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.bin')
    let observedFlags = 0
    let observedMode = 0

    await saveVerifiedBytes(destination, Buffer.from('verified bytes'), {
      open: async (path, flags, mode) => {
        observedFlags = flags
        observedMode = mode
        return open(path, flags, mode)
      }
    })

    expect(observedFlags & constants.O_CREAT).toBe(constants.O_CREAT)
    expect(observedFlags & constants.O_EXCL).toBe(constants.O_EXCL)
    expect(observedFlags & constants.O_WRONLY).toBe(constants.O_WRONLY)
    expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(observedMode).toBe(0o600)
  })
})
