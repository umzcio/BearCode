import type { OllamaInstance } from '@shared/types'

// Multi-endpoint rails (All tab pane): group the rail's refs by configured
// endpoint. The main-process registry merges every endpoint into the single
// provider row ('ollama' instances, 'compat' endpoints); non-primary models
// carry an `<endpointId>/` prefix on their id, primary models stay plain.
// Returns null when there is nothing to group — one endpoint, or every
// visible model on the primary — so the single-endpoint default renders
// exactly as before.
export function groupEndpointRefs(
  refs: string[],
  endpoints: OllamaInstance[]
): { name: string; refs: string[] }[] | null {
  if (endpoints.length < 2) return null
  const primaryId = endpoints[0].id
  const byId = new Map(endpoints.map((e) => [e.id, e]))
  const grouped = new Map<string, string[]>()
  let sawNamespaced = false
  for (const ref of refs) {
    const modelId = ref.slice(ref.indexOf('/') + 1)
    const segEnd = modelId.indexOf('/')
    const endpoint =
      segEnd > 0 && modelId.slice(0, segEnd) !== primaryId
        ? byId.get(modelId.slice(0, segEnd))
        : undefined
    if (endpoint) sawNamespaced = true
    const key = endpoint?.id ?? primaryId
    const arr = grouped.get(key)
    if (arr) arr.push(ref)
    else grouped.set(key, [ref])
  }
  if (!sawNamespaced) return null
  const out: { name: string; refs: string[] }[] = []
  for (const endpoint of endpoints) {
    const group = grouped.get(endpoint.id)
    if (group && group.length > 0) out.push({ name: endpoint.name, refs: group })
  }
  return out
}

// Multi-instance Ollama kept as a thin named wrapper — other code/tests
// reference groupOllamaRefs directly.
export function groupOllamaRefs(
  refs: string[],
  instances: OllamaInstance[]
): { name: string; refs: string[] }[] | null {
  return groupEndpointRefs(refs, instances)
}
