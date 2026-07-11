import { useAppStore } from '../state/store'

export function OutsideAccessCard(): React.JSX.Element | null {
  const pending = useAppStore((s) => s.outsideAccess?.pending ?? [])
  const allow = useAppStore((s) => s.allowOutside)
  const deny = useAppStore((s) => s.denyOutside)
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
