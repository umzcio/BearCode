import { useEffect, useRef, useState } from 'react'
import type { EffortLevel } from '@shared/types'
import { EFFORT_LEVELS, EFFORT_LABELS, effortCapabilities } from '@shared/effort'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import './EffortPicker.css'

export function EffortPicker(): React.JSX.Element {
  const effort = useAppStore((s) => s.effort)
  const thinking = useAppStore((s) => s.thinking)
  const setEffort = useAppStore((s) => s.setEffort)
  const setThinking = useAppStore((s) => s.setThinking)
  const modelRef = useAppStore((s) => s.modelRef)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { effortEnabled, thinkingEnabled } = effortCapabilities(modelRef)

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pickEffort = (level: EffortLevel): void => {
    if (!effortEnabled) return
    setEffort(level)
    setOpen(false)
  }

  return (
    <div className="effort-picker" ref={rootRef}>
      <Hint
        label={effortEnabled ? 'Reasoning effort' : 'Effort is not adjustable for this model'}
        side="top"
        disabled={open}
      >
        <button
          className={'pill-btn' + (effortEnabled ? '' : ' effort-inert')}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{EFFORT_LABELS[effort]}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      {open ? (
        <div className="menu effort-menu">
          <div className="menu-group-label">Effort</div>
          <div className="effort-help">
            Higher effort means more thorough responses, but takes longer and uses your limits
            faster.
          </div>
          {!effortEnabled ? (
            <div className="effort-help effort-unsupported">
              Effort isn’t adjustable for this model.
            </div>
          ) : null}
          {EFFORT_LEVELS.map((level) => (
            <div
              key={level}
              className={
                'menu-item effort-item' +
                (level === effort ? ' selected' : '') +
                (effortEnabled ? '' : ' disabled')
              }
              onClick={() => pickEffort(level)}
            >
              <span className="effort-label">
                {EFFORT_LABELS[level]}
                {level === 'adaptive' ? <span className="effort-default"> · Default</span> : null}
                {level === 'max' ? (
                  <Hint label="Highest cost + latency" side="top">
                    <span className="effort-info">ⓘ</span>
                  </Hint>
                ) : null}
              </span>
              {level === effort ? <span className="check">✓</span> : null}
            </div>
          ))}
          <div className="effort-sep" />
          <div
            className={'menu-item effort-thinking' + (thinkingEnabled ? '' : ' disabled')}
            onClick={() => {
              if (thinkingEnabled) setThinking(!thinking)
            }}
          >
            <span className="effort-thinking-text">
              <span className="effort-thinking-title">Thinking</span>
              <span className="effort-thinking-sub">Can think for more complex tasks</span>
            </span>
            <span className={'effort-switch' + (thinking && thinkingEnabled ? ' on' : '')} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
