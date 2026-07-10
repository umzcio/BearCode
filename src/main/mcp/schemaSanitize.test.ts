import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { sanitizeToolSchema } from './schemaSanitize'

describe('sanitizeToolSchema', () => {
  it('strips the Gemini-hostile keywords zod v4 emits for a record param', () => {
    // This is exactly what langchain-core serializes for z.record and what
    // Gemini 400s on ("Unknown name propertyNames").
    const json = z.toJSONSchema(z.record(z.string(), z.any()))
    const out = sanitizeToolSchema(json)
    expect(out).not.toHaveProperty('propertyNames')
    expect(out).not.toHaveProperty('additionalProperties')
    expect(out).not.toHaveProperty('$schema')
  })

  it('recurses into properties, items, and $defs', () => {
    const out = sanitizeToolSchema({
      $schema: 'x',
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: true },
        items: { type: 'array', items: { type: 'object', additionalProperties: {} } }
      },
      $defs: { Foo: { type: 'object', additionalProperties: true } }
    })
    expect(out).not.toHaveProperty('$schema')
    expect(out).not.toHaveProperty('additionalProperties')
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.tags).not.toHaveProperty('propertyNames')
    expect(props.tags).not.toHaveProperty('additionalProperties')
    expect((props.items.items as Record<string, unknown>)).not.toHaveProperty('additionalProperties')
    const defs = out.$defs as Record<string, Record<string, unknown>>
    expect(defs.Foo).not.toHaveProperty('additionalProperties')
  })

  it('keeps the real typed shape intact (properties, required, enum, description)', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: { q: { type: 'string', description: 'query' }, n: { type: 'integer', enum: [1, 2] } },
      required: ['q']
    })
    expect(out).toEqual({
      type: 'object',
      properties: { q: { type: 'string', description: 'query' }, n: { type: 'integer', enum: [1, 2] } },
      required: ['q']
    })
  })

  it('does not mutate the input', () => {
    const input = { type: 'object', additionalProperties: true, properties: {} }
    sanitizeToolSchema(input)
    expect(input.additionalProperties).toBe(true)
  })

  it('yields a permissive object schema for a non-object / missing input', () => {
    expect(sanitizeToolSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(sanitizeToolSchema(null)).toEqual({ type: 'object', properties: {} })
  })
})
