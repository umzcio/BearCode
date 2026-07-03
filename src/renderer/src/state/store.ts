import { create } from 'zustand'
import type {
  AppSettings,
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

interface AppState {
  sidebarCollapsed: boolean
  view: View
  conversations: Record<string, Convo>
  convoOrder: string[]
  providers: ProviderModels[]
  modelRef: ModelRef | null
  settings: SettingsInfo | null
  workspacePath: string | null
  settingsOpen: boolean
  reviewDiffId: string | null
  toast: string | null

  init(): void
  refreshProviders(): Promise<void>
  toggleSidebar(): void
  goHome(): void
  openScheduled(): void
  openConvo(id: string): void
  startFromHome(text: string): void
  send(convoId: string, text: string): void
  cancelRun(convoId: string): void
  retryRun(convoId: string): void
  selectModel(ref: ModelRef): void
  pickWorkspace(): Promise<void>
  openSettings(): void
  closeSettings(): void
  saveKey(provider: ProviderId, key: string): Promise<void>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  deleteAllConversations(): Promise<void>
  openReview(diffId: string): void
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
    view: { kind: 'home' },
    conversations: {},
    convoOrder: [],
    providers: [],
    modelRef: null,
    settings: null,
    workspacePath: null,
    settingsOpen: false,
    reviewDiffId: null,
    toast: null,

    init: () => {
      if (initialized) return
      initialized = true
      window.bearcode.onEvent(handleEvent)
      window.bearcode.onRunStateChange((convoId, state) => {
        patchConvo(convoId, { runState: state })
      })
      void (async () => {
        const settings = await window.bearcode.settings.get()
        set({ settings })
        await get().refreshProviders()
      })()
    },

    refreshProviders: async () => {
      const providers = await window.bearcode.models.list()
      set({ providers })
      ensureDefaultModel()
    },

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    goHome: () => set({ view: { kind: 'home' } }),
    openScheduled: () => set({ view: { kind: 'scheduled' } }),
    openConvo: (id) => set({ view: { kind: 'conversation', id } }),

    startFromHome: (text) => {
      const { modelRef, workspacePath } = get()
      if (!modelRef) return
      const id = crypto.randomUUID()
      const title = text.length > 42 ? text.slice(0, 42) + '…' : text
      set((s) => ({
        conversations: {
          ...s.conversations,
          [id]: {
            id,
            projectPath: workspacePath,
            projectLabel: workspacePath ? basename(workspacePath) : 'No folder',
            title,
            events: [],
            runState: 'idle'
          }
        },
        convoOrder: [id, ...s.convoOrder],
        view: { kind: 'conversation', id }
      }))
      void window.bearcode.run.start(id, text, modelRef, workspacePath)
    },

    send: (convoId, text) => {
      const { modelRef, conversations } = get()
      if (!modelRef) return
      void window.bearcode.run.start(convoId, text, modelRef, conversations[convoId].projectPath)
    },

    cancelRun: (convoId) => {
      void window.bearcode.run.cancel(convoId)
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

    openReview: (diffId) => set({ reviewDiffId: diffId }),
    closeReview: () => set({ reviewDiffId: null }),

    showToast: (message) => {
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: message })
      toastTimer = setTimeout(() => set({ toast: null }), 1800)
    }
  }
})
