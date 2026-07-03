import { create } from 'zustand'
import type { Event } from '@shared/types'
import {
  DEFAULT_MODEL,
  DEMO_ASSISTANT_TEXT,
  DEMO_COMMAND_LABEL,
  DEMO_COMMAND_OUTPUT,
  DEMO_EXPLORED_OUTPUT,
  DEMO_THINKING,
  HOME_WORKSPACE,
  MOCK_GROUPS
} from '../demo/data'

export type RunPhase = 'idle' | 'working' | 'streaming' | 'done'

export interface Convo {
  id: string
  projectLabel: string
  title: string
  age?: string
  seedDot?: boolean
  events: Event[]
  runPhase: RunPhase
  startedAt?: number
}

export type View = { kind: 'home' } | { kind: 'conversation'; id: string } | { kind: 'scheduled' }

interface AppState {
  sidebarCollapsed: boolean
  view: View
  conversations: Record<string, Convo>
  groups: { label: string; convoIds: string[]; emptyNote?: string }[]
  model: { name: string; color: string }
  reviewDiffId: string | null
  toast: string | null

  toggleSidebar(): void
  goHome(): void
  openScheduled(): void
  openConvo(id: string): void
  startFromHome(text: string): void
  send(convoId: string, text: string): void
  cancelRun(convoId: string): void
  retryRun(convoId: string): void
  selectModel(name: string, color: string): void
  openReview(diffId: string): void
  closeReview(): void
  showToast(message: string): void
}

const seededConvos: Record<string, Convo> = {}
for (const group of MOCK_GROUPS) {
  for (const seed of group.convos) {
    seededConvos[seed.id] = {
      id: seed.id,
      projectLabel: group.label,
      title: seed.name,
      age: seed.age,
      seedDot: seed.activeRun,
      events: [],
      runPhase: 'idle'
    }
  }
}

let eventSeq = 0
const nextId = (): string => `ev-${++eventSeq}`

// "Worked for Ns" per agent turn, keyed by the turn's user_message event id.
// The working phase ends when prose starts streaming, which is earlier than
// turn_meta.endedAt, so it gets its own record.
export const workedSecondsByTurn = new Map<string, number>()

// Pending timers per conversation so Stop and unload can cancel a demo run.
const timers = new Map<string, ReturnType<typeof setTimeout>[]>()
const addTimer = (convoId: string, t: ReturnType<typeof setTimeout>): void => {
  const list = timers.get(convoId) ?? []
  list.push(t)
  timers.set(convoId, list)
}
const clearTimers = (convoId: string): void => {
  for (const t of timers.get(convoId) ?? []) clearTimeout(t)
  timers.delete(convoId)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useAppStore = create<AppState>((set, get) => {
  function patchConvo(id: string, patch: Partial<Convo>): void {
    set((s) => ({
      conversations: { ...s.conversations, [id]: { ...s.conversations[id], ...patch } }
    }))
  }
  function appendEvent(convoId: string, event: Event): void {
    set((s) => {
      const convo = s.conversations[convoId]
      return {
        conversations: {
          ...s.conversations,
          [convoId]: { ...convo, events: [...convo.events, event] }
        }
      }
    })
  }

  function lastUserMessageId(convoId: string): string | undefined {
    const events = get().conversations[convoId].events
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'user_message') return events[i].id
    }
    return undefined
  }

  // Scripted agent run mirroring the prototype simulation. From Phase 4 the
  // same store is fed by real ursa events over IPC instead.
  function runDemoTurn(convoId: string): void {
    const startedAt = Date.now()
    patchConvo(convoId, { runPhase: 'working', startedAt })

    addTimer(
      convoId,
      setTimeout(() => {
        appendEvent(convoId, {
          type: 'thinking',
          id: nextId(),
          text: DEMO_THINKING,
          durationMs: 3000
        })
      }, 900)
    )

    addTimer(
      convoId,
      setTimeout(() => {
        const callId = nextId()
        appendEvent(convoId, {
          type: 'tool_call',
          id: callId,
          tool: 'list_dir',
          input: { path: '.', depth: 2 },
          approvalState: 'auto'
        })
        appendEvent(convoId, {
          type: 'tool_result',
          id: nextId(),
          callId,
          output: DEMO_EXPLORED_OUTPUT,
          durationMs: 300,
          truncated: false
        })
      }, 2000)
    )

    addTimer(
      convoId,
      setTimeout(() => {
        const callId = nextId()
        appendEvent(convoId, {
          type: 'tool_call',
          id: callId,
          tool: 'run_command',
          input: { command: DEMO_COMMAND_LABEL },
          approvalState: 'approved'
        })
        appendEvent(convoId, {
          type: 'tool_result',
          id: nextId(),
          callId,
          output: DEMO_COMMAND_OUTPUT,
          exitCode: 0,
          durationMs: 1200,
          truncated: false
        })
      }, 3200)
    )

    addTimer(
      convoId,
      setTimeout(() => {
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        const turnId = lastUserMessageId(convoId)
        if (turnId) workedSecondsByTurn.set(turnId, secs)
        patchConvo(convoId, { runPhase: 'streaming' })
        const textId = nextId()
        appendEvent(convoId, { type: 'assistant_text', id: textId, text: '' })

        let pos = 0
        const step = (): void => {
          pos = Math.min(pos + 2, DEMO_ASSISTANT_TEXT.length)
          set((s) => {
            const convo = s.conversations[convoId]
            const events = convo.events.map((e) =>
              e.id === textId && e.type === 'assistant_text'
                ? { ...e, text: DEMO_ASSISTANT_TEXT.slice(0, pos) }
                : e
            )
            return { conversations: { ...s.conversations, [convoId]: { ...convo, events } } }
          })
          if (pos < DEMO_ASSISTANT_TEXT.length) {
            addTimer(convoId, setTimeout(step, 18))
          } else {
            appendEvent(convoId, {
              type: 'file_diff',
              id: nextId(),
              diffId: 'demo-diff',
              files: [
                {
                  path: 'Chapter001/AppendixD.md',
                  additions: 64,
                  deletions: 0,
                  status: 'created'
                }
              ]
            })
            appendEvent(convoId, {
              type: 'turn_meta',
              id: nextId(),
              provider: 'demo',
              model: get().model.name,
              startedAt,
              endedAt: Date.now()
            })
            patchConvo(convoId, { runPhase: 'done' })
          }
        }
        addTimer(convoId, setTimeout(step, 18))
      }, 4700)
    )
  }

  return {
    sidebarCollapsed: false,
    view: { kind: 'home' },
    conversations: seededConvos,
    groups: MOCK_GROUPS.map((g) => ({
      label: g.label,
      convoIds: g.convos.map((c) => c.id),
      emptyNote: g.emptyNote
    })),
    model: DEFAULT_MODEL,
    reviewDiffId: null,
    toast: null,

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    goHome: () => set({ view: { kind: 'home' } }),
    openScheduled: () => set({ view: { kind: 'scheduled' } }),

    openConvo: (id) => {
      set({ view: { kind: 'conversation', id } })
      const convo = get().conversations[id]
      if (convo.events.length === 0) {
        appendEvent(id, { type: 'user_message', id: nextId(), text: convo.title })
        runDemoTurn(id)
      }
    },

    startFromHome: (text) => {
      const id = `c-${Date.now()}`
      const title = text.length > 42 ? text.slice(0, 42) + '…' : text
      set((s) => ({
        conversations: {
          ...s.conversations,
          [id]: {
            id,
            projectLabel: HOME_WORKSPACE.projectLabel,
            title,
            events: [],
            runPhase: 'idle'
          }
        },
        groups: s.groups.map((g) =>
          g.label === HOME_WORKSPACE.projectLabel ? { ...g, convoIds: [id, ...g.convoIds] } : g
        ),
        view: { kind: 'conversation', id }
      }))
      appendEvent(id, { type: 'user_message', id: nextId(), text })
      runDemoTurn(id)
    },

    send: (convoId, text) => {
      appendEvent(convoId, { type: 'user_message', id: nextId(), text })
      runDemoTurn(convoId)
    },

    cancelRun: (convoId) => {
      const convo = get().conversations[convoId]
      if (convo.runPhase !== 'working' && convo.runPhase !== 'streaming') return
      clearTimers(convoId)
      const secs = convo.startedAt
        ? Math.max(1, Math.round((Date.now() - convo.startedAt) / 1000))
        : 1
      const turnId = lastUserMessageId(convoId)
      if (turnId && !workedSecondsByTurn.has(turnId)) workedSecondsByTurn.set(turnId, secs)
      appendEvent(convoId, {
        type: 'error',
        id: nextId(),
        message: 'Cancelled',
        recoverable: true
      })
      patchConvo(convoId, { runPhase: 'done' })
    },

    retryRun: (convoId) => {
      runDemoTurn(convoId)
    },

    selectModel: (name, color) => set({ model: { name, color } }),
    openReview: (diffId) => set({ reviewDiffId: diffId }),
    closeReview: () => set({ reviewDiffId: null }),

    showToast: (message) => {
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: message })
      toastTimer = setTimeout(() => set({ toast: null }), 1800)
    }
  }
})
