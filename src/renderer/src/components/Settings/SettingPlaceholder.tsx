import type { JSX } from 'react'
import { RoarBear } from '../brand/RoarBear'

export function SettingPlaceholder({
  title,
  description
}: {
  title: string
  description: string
}): JSX.Element {
  return (
    <div className="coming-block">
      <RoarBear scale={3} />
      <span className="coming-block-title">{title}</span>
      <span className="coming-block-desc">{description}</span>
    </div>
  )
}
