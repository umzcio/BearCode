import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BearcodeApi,
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
  }
}

contextBridge.exposeInMainWorld('bearcode', bearcode)
