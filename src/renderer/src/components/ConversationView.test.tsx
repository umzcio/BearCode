// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { BearcodeApi } from '@shared/types'
import { useAppStore } from '../state/store'
import { ConversationView } from './ConversationView'

beforeEach(() => {
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {} as unknown as BearcodeApi
})
afterEach(cleanup)

describe('ConversationView user bubble', () => {
  it('renders a mention pill for each persisted user_message mention', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          id: 'c1',
          projectPath: '/p',
          title: 'T',
          modelRef: 'anthropic/claude-sonnet-5',
          permissionMode: 'accept-edits',
          updatedAt: 1,
          loaded: true,
          runState: 'idle',
          events: [
            {
              type: 'user_message',
              id: 'u1',
              text: 'look here',
              mentions: [{ kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }]
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    render(<ConversationView convoId="c1" />)
    expect(screen.getByText('@src/a.ts')).toBeTruthy()
    expect(screen.getByText('look here')).toBeTruthy()
  })
})
