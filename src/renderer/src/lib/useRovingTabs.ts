import { useCallback, useRef } from 'react'
import type { KeyboardEvent } from 'react'

interface UseRovingTabsOptions {
  ids: string[]
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
  selectedId,
  onActivate,
  tablistRef: suppliedTablistRef
}: UseRovingTabsOptions): RovingTabs {
  const localTablistRef = useRef<HTMLDivElement>(null)
  const tablistRef = suppliedTablistRef ?? localTablistRef

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (ids.length === 0) return

      const selectedIndex = Math.max(0, ids.indexOf(selectedId ?? ''))
      let nextIndex: number | null = null
      if (event.key === 'ArrowRight') nextIndex = (selectedIndex + 1) % ids.length
      else if (event.key === 'ArrowLeft') nextIndex = (selectedIndex - 1 + ids.length) % ids.length
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = ids.length - 1
      if (nextIndex === null) return

      event.preventDefault()
      const nextId = ids[nextIndex]
      const nextTab = Array.from(
        tablistRef.current?.querySelectorAll<HTMLElement>('[data-roving-tab-id]') ?? []
      ).find((tab) => tab.dataset.rovingTabId === nextId)
      nextTab?.focus()
      nextTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      onActivate(nextId)
      // Restore focus from this tablist only when activation replaced the tab
      // that received the immediate focus (for example, on a rail switch).
      queueMicrotask(() => {
        const currentTab = Array.from(
          tablistRef.current?.querySelectorAll<HTMLElement>('[data-roving-tab-id]') ?? []
        ).find((tab) => tab.dataset.rovingTabId === nextId)
        if (!currentTab || currentTab === nextTab) return
        currentTab.focus()
        currentTab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
    },
    [ids, onActivate, selectedId, tablistRef]
  )

  return { tablistRef, onKeyDown }
}
