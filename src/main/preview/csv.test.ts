import { describe, it, expect } from 'vitest'
import { parseCsv } from './csv'

describe('parseCsv', () => {
  it('parses plain rows', () => {
    expect(parseCsv('A,B\n1,2\n')).toEqual([
      ['A', 'B'],
      ['1', '2']
    ])
  })
  it('parses without a trailing newline', () => {
    expect(parseCsv('A,B\n1,2')).toEqual([
      ['A', 'B'],
      ['1', '2']
    ])
  })
  it('handles a quoted field containing a comma', () => {
    expect(parseCsv('"a,b",c\n')).toEqual([['a,b', 'c']])
  })
  it('handles an escaped double-quote inside a quoted field', () => {
    expect(parseCsv('"a""b",c\n')).toEqual([['a"b', 'c']])
  })
  it('handles a newline inside a quoted field', () => {
    expect(parseCsv('"a\nb",c\n')).toEqual([['a\nb', 'c']])
  })
})
