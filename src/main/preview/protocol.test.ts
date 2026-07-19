import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }))
vi.mock('../diffs', () => ({ filePathFor: vi.fn() }))

import { PREVIEW_CSP, mimeFor, previewUrlFor, resolvePreviewPath } from './protocol'

// Real files on disk (no fs mocks): the jail is realpath-based, so the tests
// must exercise genuine paths and symlinks, not stubs.
let root: string
let outside: string
let htmlPath: string
const lookup = (fileId: string): string | null => (fileId === 'f1' ? htmlPath : null)

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bearcode-preview-'))
  outside = mkdtempSync(join(tmpdir(), 'bearcode-outside-'))
  htmlPath = join(root, 'index.html')
  writeFileSync(htmlPath, '<h1>hi</h1>')
  writeFileSync(join(root, 'styles.css'), 'body{}')
  mkdirSync(join(root, 'img'))
  writeFileSync(join(root, 'img', 'bear.png'), 'png-bytes')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'sneaky.txt'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('resolvePreviewPath', () => {
  it('resolves the previewed file itself and sibling assets', () => {
    expect(resolvePreviewPath('/f1/index.html', lookup)).toContain('index.html')
    expect(resolvePreviewPath('/f1/styles.css', lookup)).toContain('styles.css')
    expect(resolvePreviewPath('/f1/img/bear.png', lookup)).toContain(join('img', 'bear.png'))
  })

  it('defaults to the previewed file when no relative path is given', () => {
    expect(resolvePreviewPath('/f1', lookup)).toContain('index.html')
    expect(resolvePreviewPath('/f1/', lookup)).toContain('index.html')
  })

  it('404s an unknown fileId', () => {
    expect(resolvePreviewPath('/nope/index.html', lookup)).toBeNull()
  })

  it('404s a .. escape out of the previewed directory tree', () => {
    expect(resolvePreviewPath('/f1/../secret.txt', lookup)).toBeNull()
    expect(resolvePreviewPath('/f1/img/../../secret.txt', lookup)).toBeNull()
    expect(resolvePreviewPath('/f1/%2e%2e/secret.txt', lookup)).toBeNull()
  })

  it('404s a symlink that points outside the tree', () => {
    expect(resolvePreviewPath('/f1/sneaky.txt', lookup)).toBeNull()
  })

  it('404s a directory and a missing file', () => {
    expect(resolvePreviewPath('/f1/img', lookup)).toBeNull()
    expect(resolvePreviewPath('/f1/nope.css', lookup)).toBeNull()
  })

  it('404s malformed percent-encoding instead of throwing', () => {
    expect(resolvePreviewPath('/f1/%zz', lookup)).toBeNull()
  })
})

describe('previewUrlFor', () => {
  it('builds the fixed-host URL with encoded segments', () => {
    expect(previewUrlFor('f1', '/ws/My Page.html')).toBe(
      'bearcode-preview://preview/f1/My%20Page.html'
    )
  })
})

describe('mimeFor', () => {
  it('maps common extensions and falls back to octet-stream', () => {
    expect(mimeFor('/a/index.html')).toBe('text/html')
    expect(mimeFor('/a/app.js')).toBe('text/javascript')
    expect(mimeFor('/a/bear.PNG')).toBe('image/png')
    expect(mimeFor('/a/unknown.xyz')).toBe('application/octet-stream')
  })
})

describe('PREVIEW_CSP', () => {
  it('allows no network anywhere: no http/https/ws sources in any directive', () => {
    expect(PREVIEW_CSP).not.toMatch(/https?:/)
    expect(PREVIEW_CSP).not.toMatch(/\bws:/)
    expect(PREVIEW_CSP).toContain("default-src 'none'")
    expect(PREVIEW_CSP).toContain("'unsafe-inline'")
  })
})
