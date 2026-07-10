// MCP tool input schemas come from arbitrary third-party servers. When bound to
// a model, langchain serializes them to JSON Schema (zod v4's toJSONSchema for a
// dict/record param emits `propertyNames` + `additionalProperties`), and Google
// Gemini's function-declaration API accepts only a strict OpenAPI subset — it
// 400s the ENTIRE request ("Unknown name propertyNames") on any unsupported
// keyword, killing every tool on the turn. Anthropic and OpenAI tolerate these
// keywords, so we strip them universally (dropping a validation *constraint*
// never changes a tool's callable shape) and hand `tool()` a pre-built JSON
// Schema, which it passes to every provider as-is.

// Constraint-only keywords Gemini rejects. Removing them relaxes validation but
// never changes which arguments a tool accepts, so it is safe for all providers.
const STRIP_KEYS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$comment',
  'additionalProperties',
  'propertyNames',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'additionalItems'
])

// Child positions that hold a schema (recurse into one) or an array/record of
// schemas (recurse into each).
const SCHEMA_CHILD = new Set(['items', 'not', 'if', 'then', 'else', 'contains'])
const SCHEMA_LIST = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems'])
const SCHEMA_MAP = new Set(['properties', '$defs', 'definitions'])

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeNode)
  if (node === null || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (STRIP_KEYS.has(key)) continue
    if (SCHEMA_MAP.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const mapped: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) mapped[k] = sanitizeNode(v)
      out[key] = mapped
    } else if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
      out[key] = value.map(sanitizeNode)
    } else if (SCHEMA_CHILD.has(key)) {
      out[key] = sanitizeNode(value)
    } else {
      out[key] = value
    }
  }
  return out
}

// Sanitize a JSON Schema object for provider compatibility. Pure; returns a new
// object (never mutates the input). A non-object input yields a permissive empty
// object schema so a schemaless server still produces a valid tool declaration.
export function sanitizeToolSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const cleaned = sanitizeNode(schema) as Record<string, unknown>
  // Gemini expects an object-typed parameter root; default it if the server
  // omitted `type` at the top level.
  if (cleaned.type === undefined && cleaned.properties !== undefined) cleaned.type = 'object'
  return cleaned
}
