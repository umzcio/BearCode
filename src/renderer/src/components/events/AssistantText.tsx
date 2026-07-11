import { memo } from 'react'
import { Markdown } from '../../lib/markdown'
import { useAppStore } from '../../state/store'
import './events.css'

function AssistantTextImpl({
  text,
  streaming,
  convoId
}: {
  text: string
  streaming: boolean
  convoId: string
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
      />
    </div>
  )
}
export const AssistantText = memo(AssistantTextImpl)
