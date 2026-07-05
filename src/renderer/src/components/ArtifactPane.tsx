import { useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../state/store'
import { Markdown } from '../lib/markdown'
import { ARTIFACT_STATUS_LABELS, ARTIFACT_TYPE_LABELS } from './events/ArtifactCard'
import { IconClose } from './icons'
import './ReviewPanel.css'
import './events/events.css'

type ArtifactEvent = Extract<Event, { type: 'artifact' }>

// Minimal read-only artifacts pane (Ba1; design 3.6's Ba1 subset). Lists the
// current conversation's plan/walkthrough artifacts newest first and renders
// the selected one through the sanitized markdown pipeline. No Proceed or
// Review actions, no comments (Ba2); diff "Changes" entries stay in the diff
// review pane until Ba4 unifies the two. Derived entirely from the event
// stream: artifact events carry the full body, so no IPC fetch is needed.
export function ArtifactPane({ artifactId }: { artifactId: string }): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const closeReview = useAppStore((s) => s.closeReview)
  const [selectedId, setSelectedId] = useState(artifactId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeReview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeReview])

  const convo = view.kind === 'conversation' ? conversations[view.id] : null
  if (!convo) return null
  const artifacts = convo.events.filter((e): e is ArtifactEvent => e.type === 'artifact')
  const selected =
    artifacts.find((a) => a.artifactId === selectedId) ?? artifacts[artifacts.length - 1]

  return (
    <div className="review-side">
      <div className="artifact-pane-head">
        <span className="review-head-title">Artifacts</span>
        <button className="panel-close" title="Close panel" onClick={closeReview}>
          <IconClose />
        </button>
      </div>
      <div className="artifact-rail">
        {[...artifacts].reverse().map((a) => (
          <button
            key={a.id}
            className={'artifact-rail-item' + (selected?.id === a.id ? ' selected' : '')}
            onClick={() => setSelectedId(a.artifactId)}
          >
            <span className="artifact-rail-title">
              {ARTIFACT_TYPE_LABELS[a.artifactType]} v{a.version}
            </span>
            <span className={'artifact-status ' + a.status}>
              {ARTIFACT_STATUS_LABELS[a.status]}
            </span>
          </button>
        ))}
      </div>
      <div className="review-scroll">
        {selected ? (
          <div className="artifact-view">
            <div className="artifact-view-title">{selected.title}</div>
            <Markdown text={selected.body} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
