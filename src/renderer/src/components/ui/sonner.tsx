import { useEffect, useState } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

// BearCode themes switch via data-theme on <html> (appearance.ts), not a
// class — track the attribute so sonner's own light/dark styling follows.
function useDataTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const [theme, setTheme] = useState<'light' | 'dark'>(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

// App-wide toast host. Mount once (App.tsx); fire with `toast(...)` from
// 'sonner' anywhere in the renderer. Colors come from the theme bridge vars
// (globals.css @theme inline) so both themes track tokens.css.
function Toaster({ ...props }: ToasterProps): React.JSX.Element {
  const theme = useDataTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--surface)',
          '--normal-text': 'var(--ink)',
          '--normal-border': 'var(--line-strong)',
          '--normal-border-radius': 'var(--radius-overlay)',
          '--success-bg': 'var(--surface)',
          '--success-text': 'var(--ink)',
          '--success-border': 'var(--line-strong)',
          '--error-bg': 'var(--surface)',
          '--error-text': 'var(--ink)',
          '--error-border': 'var(--line-strong)'
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
