import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Checks BOTH of BearCode's reduced-motion signals: the OS-level media query
// AND the in-app "Reduce Motion" appearance toggle (which sets
// data-motion="reduced" on <html> -- see lib/appearance.ts's applyAppearance
// and the blanket CSS rule in styles/tokens.css). Either one being true means
// motion should be reduced. Components with a JS-driven timer/animation that
// must stay in lockstep with a CSS transition duration (which tokens.css's
// blanket rule already collapses to ~0 under the in-app toggle) should use
// this instead of checking matchMedia alone.
export function prefersReducedMotion(): boolean {
  const osReduced = window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false
  const appReduced = document.documentElement.getAttribute('data-motion') === 'reduced'
  return osReduced || appReduced
}

function subscribeReducedMotion(onStoreChange: () => void): () => void {
  const media = window.matchMedia?.(REDUCED_MOTION_QUERY)
  if (typeof media?.addEventListener === 'function') {
    media.addEventListener('change', onStoreChange)
  } else {
    media?.addListener?.(onStoreChange)
  }

  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-motion']
  })

  return () => {
    if (typeof media?.removeEventListener === 'function') {
      media.removeEventListener('change', onStoreChange)
    } else {
      media?.removeListener?.(onStoreChange)
    }
    observer.disconnect()
  }
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false)
}
