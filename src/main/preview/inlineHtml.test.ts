import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { inlineHtmlAssets, injectPreviewNavGuard, GUARD_JS, GUARD_SHA256 } from './inlineHtml'

let dir: string
let htmlPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-inline-'))
  htmlPath = join(dir, 'index.html')
  writeFileSync(join(dir, 'style.css'), 'body { color: red; }')
  mkdirSync(join(dir, 'js'), { recursive: true })
  writeFileSync(join(dir, 'js', 'app.js'), 'console.log("hi")')
  // A file OUTSIDE the html dir, to prove `..` escapes are refused.
  writeFileSync(join(dir, '..', 'secret.css'), 'body { color: LEAK; }')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  try {
    rmSync(join(dir, '..', 'secret.css'))
  } catch {
    /* best effort */
  }
})

describe('inlineHtmlAssets', () => {
  it('inlines a relative stylesheet <link> as <style>', () => {
    const out = inlineHtmlAssets('<link rel="stylesheet" href="style.css">', htmlPath)
    expect(out).toContain('<style>')
    expect(out).toContain('body { color: red; }')
    expect(out).not.toContain('href="style.css"')
  })

  it('inlines a relative <script src> (in a subdir) preserving other attrs', () => {
    const out = inlineHtmlAssets('<script type="module" src="js/app.js"></script>', htmlPath)
    expect(out).toContain('console.log("hi")')
    expect(out).toContain('type="module"')
    expect(out).not.toContain('src="js/app.js"')
  })

  it('leaves external URLs untouched', () => {
    const tag = '<link rel="stylesheet" href="https://cdn.example.com/x.css">'
    expect(inlineHtmlAssets(tag, htmlPath)).toBe(tag)
  })

  it('refuses to inline a file that escapes the html directory (../)', () => {
    const tag = '<link rel="stylesheet" href="../secret.css">'
    const out = inlineHtmlAssets(tag, htmlPath)
    expect(out).toBe(tag)
    expect(out).not.toContain('LEAK')
  })

  it('does not touch non-stylesheet links (e.g. preload)', () => {
    const tag = '<link rel="preload" href="style.css" as="style">'
    expect(inlineHtmlAssets(tag, htmlPath)).toBe(tag)
  })

  it('leaves a missing asset reference as-is', () => {
    const tag = '<link rel="stylesheet" href="nope.css">'
    expect(inlineHtmlAssets(tag, htmlPath)).toBe(tag)
  })
})

describe('injectPreviewNavGuard', () => {
  it('GUARD_SHA256 matches the guard script (keep CSP hash in index.html in sync)', () => {
    const h = createHash('sha256').update(GUARD_JS).digest('base64')
    expect(h).toBe(GUARD_SHA256)
  })

  it('injects the guard script just before </body>', () => {
    const out = injectPreviewNavGuard('<body><h1>x</h1></body>')
    expect(out).toMatch(/<script>[\s\S]*scrollIntoView[\s\S]*<\/script><\/body>$/)
  })

  it('appends the guard when there is no </body>', () => {
    expect(injectPreviewNavGuard('<h1>x</h1>')).toContain('scrollIntoView')
  })
})
