import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  ConversationMeta,
  Event,
  PingResult,
  ProviderId,
  RunState
} from '../shared/types'
import { keyStatus, setKey } from './keys'
import { setSettings, settingsInfo } from './settings'
import { listAllModels } from './ursa/providers/registry'
import {
  cancelRun,
  clearConversations,
  forgetConversation,
  resolveApproval,
  setWorkspace,
  startRun
} from './ursa/run'
import { filePathFor, getDiff, revertFile } from './ursa/diffs'
import * as db from './db'
import {
  cancelRunOrchestrator,
  resolveApprovalOrchestrator,
  resumeInterruptedRuns,
  startRunOrchestrator,
  useOrchestrator
} from './orchestrator'

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
  },
  metaChanged(meta: ConversationMeta): void {
    broadcast('bearcode:conversation-meta', meta)
  }
}

// Called once from main/index.ts after the window is ready (risk 6). Uses
// the same `sink` the IPC handlers below stream through, so a conversation
// this finds mid-run gets the same live `bearcode:run-state` broadcast a
// real Stop click would produce.
export async function bootResumeInterruptedRuns(): Promise<void> {
  await resumeInterruptedRuns(sink)
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
      if (useOrchestrator()) void startRunOrchestrator(conversationId, userText, modelRef, sink)
      else void startRun(conversationId, userText, modelRef, sink)
    }
  )

  ipcMain.handle('bearcode:run:cancel', (_e, conversationId: string) => {
    if (useOrchestrator()) cancelRunOrchestrator(conversationId)
    else cancelRun(conversationId)
  })

  ipcMain.handle('bearcode:models:list', () => listAllModels())

  ipcMain.handle('bearcode:diffs:get', (_e, diffId: string) => getDiff(diffId))
  ipcMain.handle('bearcode:diffs:revert', (_e, fileId: string) => revertFile(fileId))
  ipcMain.handle('bearcode:diffs:open', (_e, fileId: string) => {
    const path = filePathFor(fileId)
    if (path) void shell.openPath(path)
  })
  ipcMain.handle('bearcode:tools:approve', (_e, callId: string, approved: boolean) => {
    if (useOrchestrator()) resolveApprovalOrchestrator(callId, approved)
    else resolveApproval(callId, approved)
  })

  ipcMain.handle('bearcode:keys:set', (_e, provider: ProviderId, key: string) => {
    setKey(provider, key)
  })
  ipcMain.handle('bearcode:keys:status', () => keyStatus())

  ipcMain.handle('bearcode:settings:get', () => settingsInfo())
  ipcMain.handle('bearcode:settings:set', (_e, patch: Partial<AppSettings>) => {
    setSettings(patch)
    return settingsInfo()
  })

  ipcMain.handle('bearcode:conversations:list', () => db.listConversations())
  ipcMain.handle('bearcode:conversations:get', (_e, id: string) => db.getEvents(id))
  ipcMain.handle('bearcode:conversations:create', (_e, projectPath: string | null) =>
    db.createConversation(projectPath)
  )
  ipcMain.handle('bearcode:conversations:delete', (_e, id: string) => {
    forgetConversation(id)
    db.deleteConversation(id)
  })
  ipcMain.handle('bearcode:conversations:clear', () => {
    clearConversations()
    db.clearAll()
  })

  ipcMain.handle('bearcode:workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
