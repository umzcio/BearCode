import type { PropsWithChildren } from 'react'

export function PreviewEntry({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="preview-entry">{children}</div>
}
