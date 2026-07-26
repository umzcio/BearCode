import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveRuleRefs, type OutsidePolicy } from './index'

let root: string, outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bc-oa-root-'))
  outside = mkdtempSync(join(tmpdir(), 'bc-oa-out-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'sub', 'in.md'), 'IN-FOLDER-CONTENT')
  writeFileSync(join(outside, 'secret.txt'), 'SECRET')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
const P = (
  policy: OutsidePolicy['policy'],
  allowed: string[] = [],
  denied: string[] = []
): OutsidePolicy => ({ policy, allowed, denied })

describe('resolveRefPath outside-folder policy', () => {
  it('relative in-folder refs always resolve regardless of policy', () => {
    const r = resolveRuleRefs('see @sub/in.md', root, { outside: P('deny') })
    expect(r.body).toContain('IN-FOLDER-CONTENT')
    expect(r.pendingOutside).toEqual([])
  })
  it('allow: out-of-folder absolute ref inlines', () => {
    const abs = join(outside, 'secret.txt')
    const r = resolveRuleRefs(`x @${abs}`, root, { outside: P('allow') })
    expect(r.body).toContain('SECRET')
    expect(r.pendingOutside).toEqual([])
  })
  it('deny: out-of-folder ref dropped, left literal, no pending', () => {
    const abs = join(outside, 'secret.txt')
    const r = resolveRuleRefs(`x @${abs}`, root, { outside: P('deny') })
    expect(r.body).not.toContain('SECRET')
    expect(r.body).toContain(`@${abs}`)
    expect(r.pendingOutside).toEqual([])
  })
  it('ask (default): dropped + recorded pending', () => {
    const abs = join(outside, 'secret.txt')
    const r = resolveRuleRefs(`x @${abs}`, root, { outside: P('ask') })
    expect(r.body).not.toContain('SECRET')
    expect(r.pendingOutside).toEqual([abs])
  })
  it('ask + already allowed: inlines, no pending', () => {
    const abs = join(outside, 'secret.txt')
    const r = resolveRuleRefs(`x @${abs}`, root, { outside: P('ask', [abs]) })
    expect(r.body).toContain('SECRET')
    expect(r.pendingOutside).toEqual([])
  })
  it('ask + already denied: dropped, no pending', () => {
    const abs = join(outside, 'secret.txt')
    const r = resolveRuleRefs(`x @${abs}`, root, { outside: P('ask', [], [abs]) })
    expect(r.body).not.toContain('SECRET')
    expect(r.pendingOutside).toEqual([])
  })
  it('no outside policy = legacy allow-everything (global rules path)', () => {
    const abs = join(outside, 'secret.txt')
    const r = resolveRuleRefs(`x @${abs}`, root) // opts omitted
    expect(r.body).toContain('SECRET')
  })
})

describe('resolveRefPath symlink containment', () => {
  it('rejects a relative ref through a symlinked intermediate directory pointing outside the workspace', () => {
    symlinkSync(outside, join(root, 'vendor'))

    const r = resolveRuleRefs('see @vendor/secret.txt', root, { outside: P('allow') })

    expect(r.body).not.toContain('SECRET')
    expect(r.body).toContain('@vendor/secret.txt')
  })

  it('rejects an absolute ref through a symlinked intermediate directory that only LEXICALLY looks in-workspace', () => {
    // A ref that is textually "root/vendor/secret.txt" (i.e. starts with the
    // project root as a string) but whose real path resolves outside it via
    // a symlinked `vendor` -- this must NOT be treated as an always-ok
    // in-workspace ref; it must fall through to the OutsidePolicy gate like
    // any other out-of-workspace ref, and specifically be denied here.
    symlinkSync(outside, join(root, 'vendor'))
    const lexicallyInWorkspace = join(root, 'vendor', 'secret.txt')

    const r = resolveRuleRefs(`x @${lexicallyInWorkspace}`, root, { outside: P('deny') })

    expect(r.body).not.toContain('SECRET')
  })

  it('a genuinely in-workspace relative ref still resolves after the realpath swap (no regression)', () => {
    const r = resolveRuleRefs('see @sub/in.md', root, { outside: P('deny') })
    expect(r.body).toContain('IN-FOLDER-CONTENT')
  })
})
