import { useLayoutEffect, useRef, useState } from 'react'
import type { EffortLevel } from '@shared/types'
import { EFFORT_LEVELS, EFFORT_LABELS, effortCapabilities } from '@shared/effort'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import { Popover } from '../ui/Popover'
import './EffortPicker.css'

export function EffortPicker(): React.JSX.Element {
  const effort = useAppStore((s) => s.effort)
  const thinking = useAppStore((s) => s.thinking)
  const setEffort = useAppStore((s) => s.setEffort)
  const setThinking = useAppStore((s) => s.setThinking)
  const modelRef = useAppStore((s) => s.modelRef)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { effortEnabled, thinkingEnabled } = effortCapabilities(modelRef)

  const pickEffort = (level: EffortLevel): void => {
    if (!effortEnabled) return
    setEffort(level)
    setOpen(false)
  }

  const toggleThinking = (): void => {
    if (thinkingEnabled) setThinking(!thinking)
  }

  // Flatten the navigable rows (effort levels + the thinking toggle) in
  // render order, skipping disabled ones.
  const flatOptions: { id: string; commit: () => void }[] = []
  if (effortEnabled) {
    EFFORT_LEVELS.forEach((level) => {
      flatOptions.push({ id: `effort-${level}`, commit: () => pickEffort(level) })
    })
  }
  if (thinkingEnabled) {
    flatOptions.push({ id: 'thinking', commit: toggleThinking })
  }

  // Popover owns click-outside/Esc/scroll dismissal + positioning. This
  // effect only seeds the roving highlight on the current effort tier and
  // focuses the listbox so it receives arrow keys -- stays a
  // useLayoutEffect (not useEffect) because Popover measures + positions
  // itself in its own useLayoutEffect on the same open transition, and
  // layout effects fire bottom-up (Popover, nested inside this component,
  // before this one), so the listbox is never `visibility: hidden` when
  // `.focus()` is called here. See Popover.tsx / ModelPicker.tsx.
  useLayoutEffect(() => {
    if (!open) return
    const i = flatOptions.findIndex((o) => o.id === `effort-${effort}`)
    setActiveIndex(i >= 0 ? i : 0)
    menuRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(flatOptions.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(flatOptions.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      flatOptions[activeIndex]?.commit()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="effort-picker">
      <Hint
        label={effortEnabled ? 'Reasoning effort' : 'Effort is not adjustable for this model'}
        side="top"
        disabled={open}
      >
        <button
          ref={triggerRef}
          className={'pill-btn' + (effortEnabled ? '' : ' effort-inert')}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{EFFORT_LABELS[effort]}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="top-end"
      >
        <div
          className="menu menu--in-popover effort-menu"
          role="listbox"
          ref={menuRef}
          tabIndex={-1}
          aria-activedescendant={`opt-${flatOptions[activeIndex]?.id}`}
          onKeyDown={onMenuKey}
        >
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
          {EFFORT_LEVELS.map((level) => {
            const idx = flatOptions.findIndex((o) => o.id === `effort-${level}`)
            return (
              <div
                key={level}
                id={`opt-effort-${level}`}
                role="option"
                aria-selected={level === effort}
                className={
                  'menu-item effort-item' +
                  (level === effort ? ' selected' : '') +
                  (idx === activeIndex ? ' active' : '') +
                  (effortEnabled ? '' : ' disabled')
                }
                onClick={() => pickEffort(level)}
                onMouseEnter={() => {
                  if (idx >= 0) setActiveIndex(idx)
                }}
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
            )
          })}
          <div className="effort-sep" />
          <div
            id="opt-thinking"
            role="option"
            aria-selected={thinking && thinkingEnabled}
            className={
              'menu-item effort-thinking' +
              (thinkingEnabled ? '' : ' disabled') +
              (flatOptions[activeIndex]?.id === 'thinking' ? ' active' : '')
            }
            onClick={toggleThinking}
            onMouseEnter={() => {
              const idx = flatOptions.findIndex((o) => o.id === 'thinking')
              if (idx >= 0) setActiveIndex(idx)
            }}
          >
            <span className="effort-thinking-text">
              <span className="effort-thinking-title">Thinking</span>
              <span className="effort-thinking-sub">Can think for more complex tasks</span>
            </span>
            <span className={'effort-switch' + (thinking && thinkingEnabled ? ' on' : '')} />
          </div>
        </div>
      </Popover>
    </div>
  )
}
