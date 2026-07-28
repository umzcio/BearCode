// Mirrors the window's focus state onto <html> as data-window-blurred so
// CSS can pause ambient paint work (the Ursa/Ursus composer glow) while
// BearCode is in the background. Electron fires window blur/focus on the
// renderer's `window` when the BrowserWindow loses/gains focus.
export function initWindowFocusTracking(): void {
  const root = document.documentElement
  const sync = (): void => {
    if (document.hasFocus()) root.removeAttribute('data-window-blurred')
    else root.setAttribute('data-window-blurred', '')
  }
  window.addEventListener('focus', sync)
  window.addEventListener('blur', sync)
  sync()
}
