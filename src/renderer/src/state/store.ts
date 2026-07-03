import { create } from 'zustand'
import type {
  AppSettings,
  ConversationMeta,
  Event,
  ModelRef,
  ProviderId,
  ProviderModels,
  RunState,
  SettingsInfo
} from '@shared/types'

export type ConvoRunState = RunState | 'idle'

export interface Convo {
  id: string
  projectPath: string | null
  projectLabel: string
  title: string
  modelRef: ModelRef | null
  updatedAt: number
  loaded: boolean
  events: Event[]
  runState: ConvoRunState
  startedAt?: number
}

export type View = { kind: 'home' } | { kind: 'conversation'; id: string } | { kind: 'scheduled' }

// "Worked for Ns" per agent turn, keyed by the turn's user_message event id.
// The working phase ends when prose starts streaming.
export const workedSecondsByTurn = new Map<string, number>()
const turnStartByConvo = new Map<string, { turnId: string; startedAt: number; frozen: boolean }>()

function basename(p: string): string {
  const parts = p.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || p
}

function fromMeta(meta: ConversationMeta): Convo {
  return {
    id: meta.id,
    projectPath: meta.projectPath,
    projectLabel: meta.projectPath ? basename(meta.projectPath) : 'No folder',
    title: meta.title ?? 'New conversation',
    modelRef: meta.modelRef,
    updatedAt: meta.updatedAt,
    loaded: false,
    events: [],
    runState: 'idle'
  }
}

function orderByRecency(conversations: Record<string, Convo>): string[] {
  return Object.values(conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => c.id)
}

interface AppState {
  sidebarCollapsed: boolean
  // Incremented by the Cmd+/ shortcut; the mounted ModelPicker toggles on change.
  modelMenuTick: number
  // Incremented by the Cmd+; shortcut; the Home project menu toggles on change.
  projectMenuTick: number
  view: View
  conversations: Record<string, Convo>
  convoOrder: string[]
  providers: ProviderModels[]
  modelRef: ModelRef | null
  settings: SettingsInfo | null
  workspacePath: string | null
  settingsOpen: boolean
  reviewDiffId: string | null
  // File path the review pane should focus when it opens (chip/step clicks).
  reviewFocusPath: string | null
  toast: string | null

  init(): void
  refreshProviders(): Promise<void>
  toggleSidebar(): void
  toggleModelMenu(): void
  goHome(): void
  openScheduled(): void
  openConvo(id: string): void
  startFromHome(text: string): void
  deleteConvo(id: string): void
  send(convoId: string, text: string): void
  cancelRun(convoId: string): void
  approveTool(callId: string, approved: boolean): void
  retryRun(convoId: string): void
  selectModel(ref: ModelRef): void
  pickWorkspace(): Promise<void>
  setWorkspace(path: string | null): void
  toggleProjectMenu(): void
  openSettings(): void
  closeSettings(): void
  saveKey(provider: ProviderId, key: string): Promise<void>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  deleteAllConversations(): Promise<void>
  openReview(diffId: string): void
  openReviewForFile(convoId: string, path: string): void
  closeReview(): void
  showToast(message: string): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false

export function modelDisplay(
  providers: ProviderModels[],
  ref: ModelRef | null
): { name: string; color: string } {
  if (ref) {
    const slash = ref.indexOf('/')
    const providerId = ref.slice(0, slash)
    const modelId = ref.slice(slash + 1)
    const provider = providers.find((p) => p.id === providerId)
    if (provider) {
      const model = provider.models.find((m) => m.id === modelId)
      return { name: model?.label ?? modelId, color: provider.color }
    }
  }
  return { name: 'Choose a model', color: '#6f6f6f' }
}

export function refConfigured(providers: ProviderModels[], ref: ModelRef | null): boolean {
  if (!ref) return false
  const providerId = ref.slice(0, ref.indexOf('/'))
  const provider = providers.find((p) => p.id === providerId)
  return Boolean(provider && provider.keyConfigured && provider.reachable)
}

export const useAppStore = create<AppState>((set, get) => {
  function patchConvo(id: string, patch: Partial<Convo>): void {
    set((s) => {
      const convo = s.conversations[id]
      if (!convo) return s
      return { conversations: { ...s.conversations, [id]: { ...convo, ...patch } } }
    })
  }

  function upsertEvent(convoId: string, event: Event): void {
    set((s) => {
      const convo = s.conversations[convoId]
      if (!convo) return s
      const index = convo.events.findIndex((e) => e.id === event.id)
      const events =
        index >= 0
          ? convo.events.map((e, i) => (i === index ? event : e))
          : [...convo.events, event]
      return { conversations: { ...s.conversations, [convoId]: { ...convo, events } } }
    })
  }

  function handleEvent(convoId: string, event: Event): void {
    // Track per-turn worked time: a turn's working phase runs from its
    // user_message until the first streamed prose or a terminal error.
    if (event.type === 'user_message') {
      turnStartByConvo.set(convoId, { turnId: event.id, startedAt: Date.now(), frozen: false })
      patchConvo(convoId, { startedAt: Date.now() })
    } else if (event.type === 'assistant_text' || event.type === 'error') {
      const turn = turnStartByConvo.get(convoId)
      if (turn && !turn.frozen) {
        turn.frozen = true
        workedSecondsByTurn.set(
          turn.turnId,
          Math.max(1, Math.round((Date.now() - turn.startedAt) / 1000))
        )
      }
    }
    upsertEvent(convoId, event)
  }

  function ensureDefaultModel(): void {
    const { providers, settings, modelRef } = get()
    if (modelRef && refConfigured(providers, modelRef)) return
    const stored = settings?.defaultModelRef ?? null
    if (stored && refConfigured(providers, stored)) {
      set({ modelRef: stored })
      return
    }
    for (const p of providers) {
      if (p.keyConfigured && p.reachable && p.models.length > 0) {
        set({ modelRef: `${p.id}/${p.models[0].id}` })
        return
      }
    }
    // Nothing configured: keep a sensible visible selection so the picker
    // has an anchor; the composer shows the add-a-key notice.
    if (!modelRef) {
      const first = providers.find((p) => p.models.length > 0)
      if (first) set({ modelRef: `${first.id}/${first.models[0].id}` })
    }
  }

  return {
    sidebarCollapsed: false,
    modelMenuTick: 0,
    projectMenuTick: 0,
    view: { kind: 'home' },
    conversations: {},
    convoOrder: [],
    providers: [],
    modelRef: null,
    settings: null,
    workspacePath: null,
    settingsOpen: false,
    reviewDiffId: null,
    reviewFocusPath: null,
    toast: null,

    init: () => {
      if (initialized) return
      initialized = true
      window.bearcode.onEvent(handleEvent)
      window.bearcode.onRunStateChange((convoId, state) => {
        patchConvo(convoId, { runState: state })
      })
      window.bearcode.onConversationMeta((meta) => {
        set((s) => {
          const existing = s.conversations[meta.id]
          if (!existing) return s
          const conversations = {
            ...s.conversations,
            [meta.id]: {
              ...existing,
              title: meta.title ?? existing.title,
              modelRef: meta.modelRef,
              updatedAt: meta.updatedAt
            }
          }
          return { conversations, convoOrder: orderByRecency(conversations) }
        })
      })
      void (async () => {
        const settings = await window.bearcode.settings.get()
        set({ settings })
        const metas = await window.bearcode.conversations.list()
        const conversations: Record<string, Convo> = {}
        for (const meta of metas) conversations[meta.id] = fromMeta(meta)
        set({ conversations, convoOrder: orderByRecency(conversations) })
        await get().refreshProviders()
      })()
    },

    refreshProviders: async () => {
      const providers = await window.bearcode.models.list()
      set({ providers })
      ensureDefaultModel()
    },

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    toggleModelMenu: () => set((s) => ({ modelMenuTick: s.modelMenuTick + 1 })),
    goHome: () => set({ view: { kind: 'home' } }),
    openScheduled: () => set({ view: { kind: 'scheduled' } }),
    openConvo: (id) => {
      set({ view: { kind: 'conversation', id } })
      const convo = get().conversations[id]
      if (!convo) return
      // Restore the model the conversation last used.
      if (convo.modelRef && refConfigured(get().providers, convo.modelRef)) {
        set({ modelRef: convo.modelRef })
      }
      if (!convo.loaded && convo.runState === 'idle') {
        void window.bearcode.conversations.get(id).then((events) => {
          patchConvo(id, { events, loaded: true })
        })
      }
    },

    startFromHome: (text) => {
      const { modelRef, workspacePath } = get()
      if (!modelRef) return
      void (async () => {
        const meta = await window.bearcode.conversations.create(workspacePath)
        const provisional = text.length > 42 ? text.slice(0, 42) + '…' : text
        const convo = { ...fromMeta(meta), title: provisional, loaded: true }
        set((s) => {
          const conversations = { ...s.conversations, [meta.id]: convo }
          return {
            conversations,
            convoOrder: orderByRecency(conversations),
            view: { kind: 'conversation', id: meta.id }
          }
        })
        await window.bearcode.run.start(meta.id, text, modelRef, workspacePath)
      })()
    },

    deleteConvo: (id) => {
      void window.bearcode.conversations.delete(id).then(() => {
        set((s) => {
          const conversations = { ...s.conversations }
          delete conversations[id]
          const view =
            s.view.kind === 'conversation' && s.view.id === id ? { kind: 'home' as const } : s.view
          return { conversations, convoOrder: orderByRecency(conversations), view }
        })
        get().showToast('Conversation deleted')
      })
    },

    send: (convoId, text) => {
      const { modelRef, conversations } = get()
      if (!modelRef) return
      patchConvo(convoId, { modelRef })
      void window.bearcode.run.start(convoId, text, modelRef, conversations[convoId].projectPath)
    },

    cancelRun: (convoId) => {
      void window.bearcode.run.cancel(convoId)
    },

    approveTool: (callId, approved) => {
      void window.bearcode.tools.approve(callId, approved)
    },

    retryRun: (convoId) => {
      const { conversations, modelRef } = get()
      if (!modelRef) return
      const convo = conversations[convoId]
      const lastUser = [...convo.events].reverse().find((e) => e.type === 'user_message')
      if (!lastUser || lastUser.type !== 'user_message') return
      void window.bearcode.run.start(convoId, lastUser.text, modelRef, convo.projectPath)
    },

    selectModel: (ref) => {
      set({ modelRef: ref })
      void window.bearcode.settings.set({ defaultModelRef: ref }).then((settings) => {
        set({ settings })
      })
    },

    pickWorkspace: async () => {
      const path = await window.bearcode.workspace.pick()
      if (path) set({ workspacePath: path })
    },
    setWorkspace: (path) => set({ workspacePath: path }),
    toggleProjectMenu: () => set((s) => ({ projectMenuTick: s.projectMenuTick + 1 })),

    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),

    saveKey: async (provider, key) => {
      await window.bearcode.keys.set(provider, key)
      await get().refreshProviders()
      get().showToast(key ? 'API key saved' : 'API key removed')
    },

    saveSettings: async (patch) => {
      const settings = await window.bearcode.settings.set(patch)
      set({ settings })
      if (patch.ollamaBaseUrl !== undefined) await get().refreshProviders()
    },

    deleteAllConversations: async () => {
      await window.bearcode.conversations.clear()
      turnStartByConvo.clear()
      workedSecondsByTurn.clear()
      set({ conversations: {}, convoOrder: [], view: { kind: 'home' } })
      get().showToast('All conversations deleted')
    },

    openReview: (diffId) => set({ reviewDiffId: diffId, reviewFocusPath: null }),
    openReviewForFile: (convoId, path) => {
      const convo = get().conversations[convoId]
      if (!convo) return
      const name = path.split('/').pop() ?? path
      for (let i = convo.events.length - 1; i >= 0; i--) {
        const ev = convo.events[i]
        if (ev.type !== 'file_diff') continue
        const match = ev.files.find(
          (f) => f.path === path || f.path.endsWith('/' + name) || f.path === name
        )
        if (match) {
          set({ reviewDiffId: ev.diffId, reviewFocusPath: match.path })
          return
        }
      }
    },
    closeReview: () => set({ reviewDiffId: null, reviewFocusPath: null }),

    showToast: (message) => {
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: message })
      toastTimer = setTimeout(() => set({ toast: null }), 1800)
    }
  }
})
