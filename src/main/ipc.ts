import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { AppSettings, Event, PingResult, ProviderId, RunState } from '../shared/types'
import { keyStatus, setKey } from './keys'
import { setSettings, settingsInfo } from './settings'
import { listAllModels } from './ursa/providers/registry'
import { cancelRun, clearConversations, setWorkspace, startRun } from './ursa/run'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

const sink = {
  emit(conversationId: string, event: Event): void {
    broadcast('bearcode:event', conversationId, event)
  },
  setState(conversationId: string, state: RunState): void {
    broadcast('bearcode:run-state', conversationId, state)
  }
}

export function registerIpc(): void {
  ipcMain.handle('bearcode:ping', (): PingResult => {
    return {
      message: 'pong',
      electron: process.versions.electron,
      node: process.versions.node,
      respondedAt: Date.now()
    }
  })

  ipcMain.handle(
    'bearcode:run:start',
    (
      _e,
      conversationId: string,
      userText: string,
      modelRef: string,
      projectPath: string | null
    ) => {
      setWorkspace(conversationId, projectPath)
      // Fire and forget: progress flows back over bearcode:event.
      void startRun(conversationId, userText, modelRef, sink)
    }
  )

  ipcMain.handle('bearcode:run:cancel', (_e, conversationId: string) => {
    cancelRun(conversationId)
  })

  ipcMain.handle('bearcode:models:list', () => listAllModels())

  ipcMain.handle('bearcode:keys:set', (_e, provider: ProviderId, key: string) => {
    setKey(provider, key)
  })
  ipcMain.handle('bearcode:keys:status', () => keyStatus())

  ipcMain.handle('bearcode:settings:get', () => settingsInfo())
  ipcMain.handle('bearcode:settings:set', (_e, patch: Partial<AppSettings>) => {
    setSettings(patch)
    return settingsInfo()
  })

  ipcMain.handle('bearcode:conversations:clear', () => {
    clearConversations()
  })

  ipcMain.handle('bearcode:workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
