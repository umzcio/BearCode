import type { JSX } from 'react'

// Small provenance pill shown next to skills/rules/connectors that were
// contributed by a plugin rather than configured directly. Mirrors the
// `.connector-badge` treatment.
export function PluginBadge({ name }: { name: string }): JSX.Element {
  return (
    <span className="plugin-badge" title={`Provided by the ${name} plugin`}>
      Plugin: {name}
    </span>
  )
}
