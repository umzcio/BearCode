import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileCapped } from './fsCapped'

describe('readFileCapped', () => {
  let dir: string
  let outsideDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-fscapped-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-fscapped-outside-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('returns the file content for a normal regular file', () => {
    const filePath = join(dir, 'CLAUDE.md')
    writeFileSync(filePath, 'hello world')
    expect(readFileCapped(filePath, 1024)).toEqual({ text: 'hello world', truncated: false })
  })

  it('returns null for a symlink pointing at a valid file outside the project', () => {
    const outsideFile = join(outsideDir, 'id_rsa')
    writeFileSync(outsideFile, 'super secret content')
    const linkPath = join(dir, 'CLAUDE.md')
    symlinkSync(outsideFile, linkPath)
    expect(readFileCapped(linkPath, 1024)).toBeNull()
  })

  it('returns null for a dangling symlink without throwing', () => {
    const linkPath = join(dir, 'CLAUDE.md')
    symlinkSync(join(outsideDir, 'does-not-exist'), linkPath)
    expect(() => readFileCapped(linkPath, 1024)).not.toThrow()
    expect(readFileCapped(linkPath, 1024)).toBeNull()
  })

  it('still returns null for a non-regular file (directory)', () => {
    expect(readFileCapped(dir, 1024)).toBeNull()
  })
})
