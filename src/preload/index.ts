import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BearcodeApi,
  ConversationMeta,
  Event,
  ModelRef,
  ProviderId,
  RunState
} from '../shared/types'

// The renderer talks to main only through this typed surface.
const bearcode: BearcodeApi = {
  ping: () => ipcRenderer.invoke('bearcode:ping'),
  run: {
    start: (conversationId: string, userText: string, modelRef: ModelRef, projectPath) =>
      ipcRenderer.invoke('bearcode:run:start', conversationId, userText, modelRef, projectPath),
    cancel: (conversationId: string) => ipcRenderer.invoke('bearcode:run:cancel', conversationId)
  },
  models: {
    list: () => ipcRenderer.invoke('bearcode:models:list')
  },
  diffs: {
    get: (diffId: string) => ipcRenderer.invoke('bearcode:diffs:get', diffId),
    accept: (fileId: string) => ipcRenderer.invoke('bearcode:diffs:accept', fileId),
    reject: (fileId: string) => ipcRenderer.invoke('bearcode:diffs:reject', fileId),
    open: (fileId: string) => ipcRenderer.invoke('bearcode:diffs:open', fileId)
  },
  tools: {
    approve: (callId: string, approved: boolean) =>
      ipcRenderer.invoke('bearcode:tools:approve', callId, approved)
  },
  keys: {
    set: (provider: ProviderId, key: string) =>
      ipcRenderer.invoke('bearcode:keys:set', provider, key),
    status: () => ipcRenderer.invoke('bearcode:keys:status')
  },
  settings: {
    get: () => ipcRenderer.invoke('bearcode:settings:get'),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke('bearcode:settings:set', patch)
  },
  conversations: {
    list: () => ipcRenderer.invoke('bearcode:conversations:list'),
    get: (id: string) => ipcRenderer.invoke('bearcode:conversations:get', id),
    create: (projectPath: string | null) =>
      ipcRenderer.invoke('bearcode:conversations:create', projectPath),
    delete: (id: string) => ipcRenderer.invoke('bearcode:conversations:delete', id),
    clear: () => ipcRenderer.invoke('bearcode:conversations:clear')
  },
  workspace: {
    pick: () => ipcRenderer.invoke('bearcode:workspace:pick')
  },
  onEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, conversationId: string, event: Event): void =>
      cb(conversationId, event)
    ipcRenderer.on('bearcode:event', listener)
    return () => ipcRenderer.removeListener('bearcode:event', listener)
  },
  onRunStateChange: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      conversationId: string,
      state: RunState
    ): void => cb(conversationId, state)
    ipcRenderer.on('bearcode:run-state', listener)
    return () => ipcRenderer.removeListener('bearcode:run-state', listener)
  },
  onConversationMeta: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, meta: ConversationMeta): void => cb(meta)
    ipcRenderer.on('bearcode:conversation-meta', listener)
    return () => ipcRenderer.removeListener('bearcode:conversation-meta', listener)
  }
}

contextBridge.exposeInMainWorld('bearcode', bearcode)
