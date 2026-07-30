import { IconPaw } from '../icons'

// The paw + "Artifacts" wordmark that opens Row 1 of every panel variant.
export function ApBrand(): React.JSX.Element {
  return (
    <>
      <span className="ap-paw" aria-hidden="true">
        <IconPaw />
      </span>
      <span className="ap-title">Artifacts</span>
    </>
  )
}
