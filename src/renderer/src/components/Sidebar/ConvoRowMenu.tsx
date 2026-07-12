import { useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { IconDots } from '../icons'
import { Menu, type MenuGroup } from '../ui/Menu'
import './ConvoRowMenu.css'

export function ConvoRowMenu({
  convoId,
  title
}: {
  convoId: string
  title: string
}): React.JSX.Element {
  const renameConversation = useAppStore((s) => s.renameConversation)
  const deleteConvo = useAppStore((s) => s.deleteConvo)
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const groups: MenuGroup[] = [
    {
      items: [
        { value: 'rename', label: 'Rename' },
        { value: 'delete', label: 'Delete Conversation', danger: true }
      ]
    }
  ]

  const handleSelect = (value: string): void => {
    if (value === 'rename') {
      const next = window.prompt('Rename conversation', title)?.trim()
      if (next) renameConversation(convoId, next)
    } else if (value === 'delete') {
      if (window.confirm(`Delete "${title}"?`)) deleteConvo(convoId)
    }
  }

  return (
    <div className="convo-menu" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        className={open ? 'row-act menu-open' : 'row-act'}
        title="More"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <IconDots size={14} />
      </button>
      <Menu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        groups={groups}
        onSelect={handleSelect}
        placement="bottom-start"
        ariaLabel="Conversation actions"
      />
    </div>
  )
}
