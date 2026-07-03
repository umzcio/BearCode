import { Markdown } from '../../lib/markdown'
import './events.css'

export function AssistantText({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.JSX.Element {
  return (
    <div className="agent-text">
      <Markdown text={text} trailing={streaming ? <span className="cursor" /> : undefined} />
    </div>
  )
}
