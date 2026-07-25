import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { VerifiedStoredAttachment } from '../hermes/attachmentAccess'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }))
vi.mock('../diffs', () => ({ filePathFor: vi.fn() }))

import {
  PREVIEW_CSP,
  attachmentPreviewUrlFor,
  handlePreviewRequest,
  mimeFor,
  previewUrlFor,
  resolvePreviewPath
} from './protocol'

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

describe('attachmentPreviewUrlFor', () => {
  it('builds an opaque attachment URL with an encoded display name', () => {
    expect(attachmentPreviewUrlFor('conv_123', 'att_123', 'My page.html')).toBe(
      'bearcode-preview://attachment/conv_123/att_123/My%20page.html'
    )
  })

  it('sanitizes traversal, backslashes, and control characters from the display segment', () => {
    expect(attachmentPreviewUrlFor('conv_123', 'att_123', '../../My\\\u0000Page.html')).toBe(
      'bearcode-preview://attachment/conv_123/att_123/MyPage.html'
    )
  })
})

describe('handlePreviewRequest', () => {
  const attachment: VerifiedStoredAttachment = {
    attachment: {
      id: 'att_123',
      name: 'verified.html',
      mime: 'application/octet-stream',
      kind: 'document',
      sizeBytes: 17,
      sha256: '0'.repeat(64)
    },
    bytes: Buffer.from('<h1>Verified</h1>')
  }

  it('serves only verified attachment bytes with isolated preview headers', async () => {
    const calls: unknown[][] = []
    const readAttachment = async (...args: [string, string]): Promise<VerifiedStoredAttachment> => {
      calls.push(args)
      return attachment
    }

    const response = await handlePreviewRequest(
      new Request('bearcode-preview://attachment/conv_123/att_123/Misleading%20name.txt'),
      { readAttachment }
    )

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(attachment.bytes)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Content-Security-Policy')).toBe(PREVIEW_CSP)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(calls).toEqual([['conv_123', 'att_123']])
  })

  it.each([
    {
      label: 'malformed encoding',
      request: new Request('bearcode-preview://attachment/conv_123/att_123/%zz')
    },
    {
      label: 'invalid conversation ID',
      request: new Request('bearcode-preview://attachment/bad%2Fconv/att_123/page.html')
    },
    {
      label: 'invalid attachment ID',
      request: new Request('bearcode-preview://attachment/conv_123/bad%2Fatt/page.html')
    },
    {
      label: 'unknown host',
      request: new Request('bearcode-preview://unknown/conv_123/att_123/page.html')
    },
    {
      label: 'non-GET method',
      request: new Request('bearcode-preview://attachment/conv_123/att_123/page.html', {
        method: 'POST'
      })
    }
  ])('returns a 4xx for $label without reading attachment bytes', async ({ request }) => {
    let reads = 0
    const response = await handlePreviewRequest(request, {
      readAttachment: async () => {
        reads += 1
        return attachment
      }
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(reads).toBe(0)
  })

  it('rejects attachment sibling assets without calling the verified reader', async () => {
    let reads = 0
    const response = await handlePreviewRequest(
      new Request('bearcode-preview://attachment/conv_123/att_123/My%20page.html/style.css'),
      {
        readAttachment: async () => {
          reads += 1
          return attachment
        }
      }
    )

    expect(response.status).toBe(404)
    expect(reads).toBe(0)
  })

  it('keeps serving the diff preview file and its sibling assets', async () => {
    const dependencies = { filePathFor: lookup }

    const documentResponse = await handlePreviewRequest(
      new Request('bearcode-preview://preview/f1/index.html'),
      dependencies
    )
    const assetResponse = await handlePreviewRequest(
      new Request('bearcode-preview://preview/f1/styles.css'),
      dependencies
    )

    expect(documentResponse.status).toBe(200)
    expect(await documentResponse.text()).toBe('<h1>hi</h1>')
    expect(documentResponse.headers.get('Content-Type')).toContain('text/html')
    expect(assetResponse.status).toBe(200)
    expect(await assetResponse.text()).toBe('body{}')
    expect(assetResponse.headers.get('Content-Type')).toContain('text/css')
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
