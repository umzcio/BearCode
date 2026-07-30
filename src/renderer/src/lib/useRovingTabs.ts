import { useCallback, useRef } from 'react'
import type { KeyboardEvent } from 'react'

interface UseRovingTabsOptions {
  ids: string[]
  disabledIds?: string[]
  selectedId: string | undefined
  onActivate: (id: string) => void
  tablistRef?: React.RefObject<HTMLDivElement | null>
}

interface RovingTabs {
  tablistRef: React.RefObject<HTMLDivElement | null>
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

// Keeps an automatically activated tablist self-contained: it only looks up
// tabs below its own container, so a Monaco editor or another tablist cannot
// receive this group's arrow-key behavior.
export function useRovingTabs({
  ids,
  disabledIds = [],
  selectedId,
  onActivate,
  tablistRef: suppliedTablistRef
}: UseRovingTabsOptions): RovingTabs {
  const localTablistRef = useRef<HTMLDivElement>(null)
  const tablistRef = suppliedTablistRef ?? localTablistRef

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (ids.length === 0) return

      const tabFor = (id: string): HTMLElement | undefined =>
        Array.from(
          tablistRef.current?.querySelectorAll<HTMLElement>('[data-roving-tab-id]') ?? []
        ).find((tab) => tab.dataset.rovingTabId === id)
      const isDisabled = (id: string): boolean => {
        const tab = tabFor(id)
        return (
          disabledIds.includes(id) ||
          tab?.matches(':disabled') === true ||
          tab?.getAttribute('aria-disabled') === 'true'
        )
      }
      const firstEnabled = (): number => ids.findIndex((id) => !isDisabled(id))
      const lastEnabled = (): number => {
        for (let index = ids.length - 1; index >= 0; index--) {
          if (!isDisabled(ids[index])) return index
        }
        return -1
      }
      const stepEnabled = (from: number, direction: 1 | -1): number => {
        for (let attempts = 0, index = from; attempts < ids.length; attempts++) {
          index = (index + direction + ids.length) % ids.length
          if (!isDisabled(ids[index])) return index
        }
        return -1
      }
      const selectedIndex = Math.max(0, ids.indexOf(selectedId ?? ''))
      let nextIndex: number | null = null
      if (event.key === 'ArrowRight') nextIndex = stepEnabled(selectedIndex, 1)
      else if (event.key === 'ArrowLeft') nextIndex = stepEnabled(selectedIndex, -1)
      else if (event.key === 'Home') nextIndex = firstEnabled()
      else if (event.key === 'End') nextIndex = lastEnabled()
      if (nextIndex === null || nextIndex < 0) return

      event.preventDefault()
      const nextId = ids[nextIndex]
      const nextTab = tabFor(nextId)
      if (!nextTab || isDisabled(nextId)) return
      nextTab.focus()
      nextTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      onActivate(nextId)
      // Restore focus from this tablist only when activation replaced the tab
      // that received the immediate focus (for example, on a rail switch).
      queueMicrotask(() => {
        const currentTab = tabFor(nextId)
        if (!currentTab || currentTab === nextTab) return
        currentTab.focus()
        currentTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      })
    },
    [disabledIds, ids, onActivate, selectedId, tablistRef]
  )

  return { tablistRef, onKeyDown }
}
