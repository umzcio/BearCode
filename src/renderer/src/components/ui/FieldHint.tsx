export interface FieldHintProps {
  show: boolean
  children: React.ReactNode
}

// The shared inline validation note under a form field (was forked as
// `.hook-field-hint` in Settings.css) -- renders nothing when `show` is
// false so callers can mount it unconditionally without a layout flash.
export function FieldHint({ show, children }: FieldHintProps): React.JSX.Element | null {
  if (!show) return null
  return <div className="field-hint">{children}</div>
}
