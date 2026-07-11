import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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
