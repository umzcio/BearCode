import { useAppStore } from '../state/store'

export function OutsideAccessCard(): React.JSX.Element | null {
  // Select the stable object reference; do the [] fallback in render, NOT inside
  // the selector — a `?? []` in the selector returns a fresh array every call,
  // which makes useSyncExternalStore see a changed snapshot each render and loop
  // ("getSnapshot should be cached" → "Maximum update depth exceeded").
  const outsideAccess = useAppStore((s) => s.outsideAccess)
  const allow = useAppStore((s) => s.allowOutside)
  const deny = useAppStore((s) => s.denyOutside)
  const pending = outsideAccess?.pending ?? []
  if (pending.length === 0) return null
  return (
    <div className="outside-access-card" role="alert">
      <div className="outside-access-title">A rule wants to read files outside this folder</div>
      {pending.map((p) => (
        <div className="outside-access-row" key={p}>
          <code className="outside-access-path">{p}</code>
          <span className="outside-access-actions">
            <button className="pill-btn" onClick={() => void deny(p)}>
              Deny
            </button>
            <button className="pill-btn primary" onClick={() => void allow(p)}>
              Allow this path
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}
