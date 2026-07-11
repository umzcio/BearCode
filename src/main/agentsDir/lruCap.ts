// Insertion-order LRU eviction for the agentsDir parse caches (audit M-13).
// Map iteration order is insertion order, so delete-then-set moves a key to
// "most recent"; when over cap we drop from the front (oldest).
export function capMap<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value as K
    map.delete(oldest)
  }
}
