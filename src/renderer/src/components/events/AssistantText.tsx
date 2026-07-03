import { Markdown } from '../../lib/markdown'
import { useAppStore } from '../../state/store'
import './events.css'

export function AssistantText({
  text,
  streaming,
  convoId
}: {
  text: string
  streaming: boolean
  convoId: string
}): React.JSX.Element {
  const openReviewForFile = useAppStore((s) => s.openReviewForFile)
  return (
    <div className="agent-text">
      <Markdown
        text={text}
        trailing={streaming ? <span className="cursor" /> : undefined}
        onFileClick={(path) => openReviewForFile(convoId, path)}
      />
    </div>
  )
}
