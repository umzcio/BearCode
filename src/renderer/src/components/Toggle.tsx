import type { JSX } from 'react'

// A custom-styled on/off switch (never a native checkbox). Accessible via
// role="switch" + aria-checked. Used by the F7 Models page opt-out toggles.
export function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  ariaLabel: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={'toggle' + (checked ? ' on' : '')}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <span className="toggle-knob" />
    </button>
  )
}
