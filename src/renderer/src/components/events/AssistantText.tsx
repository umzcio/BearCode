import { memo } from 'react'
import { Markdown } from '../../lib/markdown'
import type { SourceCitation } from '@shared/types'
import { useAppStore } from '../../state/store'
import './events.css'

function AssistantTextImpl({
  text,
  streaming,
  convoId,
  citations
}: {
  text: string
  streaming: boolean
  convoId: string
  // The turn's web sources (turn_meta.citations): when present, [n] markers in
  // the prose render as links to citations[n-1]. Arrives only once the turn
  // completes, so a streaming answer shows plain markers until it settles.
  citations?: SourceCitation[]
}): React.JSX.Element {
  const openReviewForFile = useAppStore((s) => s.openReviewForFile)
  const openFile = useAppStore((s) => s.openFile)
  return (
    <div className="agent-text">
      <Markdown
        text={text}
        trailing={streaming ? <span className="cursor" /> : undefined}
        onFileClick={(path) => openReviewForFile(convoId, path)}
        onFileOpen={(path) => openFile(path)}
        citations={citations}
      />
    </div>
  )
}
export const AssistantText = memo(AssistantTextImpl)
