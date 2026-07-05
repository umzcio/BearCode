import { randomUUID } from 'crypto'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AddRuleInput,
  AppSettings,
  ArtifactComment,
  ConversationMeta,
  Event,
  ExecutionMode,
  PermissionMode,
  PingResult,
  ProviderId,
  RunState
} from '../shared/types'
import { keyStatus, setKey } from './keys'
import { addUserRule, deleteUserRule, listRulesInfo, setBuiltinDisabled } from './permissions'
import { setSettings, settingsInfo } from './settings'
import { listAllModels } from './providers/registry'
import { filePathFor, getDiff, revertFile } from './diffs'
import * as db from './db'
import {
  assertValidPlanReviewResolution,
  cancelRunOrchestrator,
  clearRunsOrchestrator,
  forgetRunOrchestrator,
  pruneCheckpoints,
  resolveApprovalOrchestrator,
  resolvePlanReviewOrchestrator,
  resumeInterruptedRuns,
  startRunOrchestrator
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

// Called once from main/index.ts after the window is ready. Uses the same
// `sink` the IPC handlers below stream through, so a conversation this finds
// dangling gets the same live broadcasts a real run would produce. Attempts
// full crash-resume of any approval-paused run (A2), falling back to a clean
// 'cancelled' for mid-stream crashes.
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
      _projectPath: string | null
    ) => {
      // projectPath is already persisted on the conversation row (set at
      // creation); the orchestrator reads it back from getConversationMeta, so
      // nothing to stash here. Fire and forget: progress flows back over
      // bearcode:event.
      void startRunOrchestrator(conversationId, userText, modelRef, sink)
    }
  )

  ipcMain.handle('bearcode:run:cancel', (_e, conversationId: string) => {
    cancelRunOrchestrator(conversationId)
  })

  ipcMain.handle('bearcode:models:list', () => listAllModels())

  ipcMain.handle('bearcode:diffs:get', (_e, diffId: string) => getDiff(diffId))
  ipcMain.handle('bearcode:diffs:revert', (_e, fileId: string) => revertFile(fileId))
  ipcMain.handle('bearcode:diffs:open', (_e, fileId: string) => {
    const path = filePathFor(fileId)
    if (path) void shell.openPath(path)
  })
  ipcMain.handle('bearcode:tools:approve', (_e, callId: string, approved: boolean) => {
    resolveApprovalOrchestrator(callId, approved)
  })

  ipcMain.handle(
    'bearcode:artifacts:resolve-plan-review',
    (_e, callId: string, proceed: boolean, message?: string) => {
      // assertValidPlanReviewResolution throws on anything looser than a
      // literal boolean/string|undefined, which ipcMain.handle turns into a
      // rejected promise for the renderer -- see its doc comment
      // (orchestrator/index.ts) for why this must happen before the call in.
      assertValidPlanReviewResolution(proceed, message)
      return resolvePlanReviewOrchestrator(callId, proceed, message)
    }
  )
  ipcMain.handle(
    'bearcode:artifacts:add-comment',
    (_e, artifactId: string, quote: string | null, body: string): ArtifactComment => {
      const trimmedBody = body.trim()
      if (!trimmedBody) throw new Error('Comment body must not be empty')
      const comment: ArtifactComment = {
        id: randomUUID(),
        artifactId,
        quote: quote && quote.trim() ? quote.trim() : null,
        body: trimmedBody,
        createdAt: Date.now(),
        sentAt: null
      }
      db.insertArtifactComment(comment)
      return comment
    }
  )
  ipcMain.handle('bearcode:artifacts:list-comments', (_e, artifactId: string) =>
    db.listArtifactComments(artifactId)
  )

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
    forgetRunOrchestrator(id)
    void pruneCheckpoints(id)
    db.deleteConversation(id)
  })
  ipcMain.handle('bearcode:conversations:set-mode', (_e, id: string, mode: PermissionMode) => {
    db.setPermissionMode(id, mode)
  })
  ipcMain.handle(
    'bearcode:conversations:set-execution-mode',
    (_e, id: string, mode: ExecutionMode) => {
      // Enum-validate at the boundary: this string lands in a TEXT column and
      // later selects system-prompt content, so main never trusts the
      // renderer (the assertValidPlanReviewResolution posture).
      if (mode !== 'planning' && mode !== 'fast') {
        throw new Error(`Unknown execution mode: ${String(mode)}`)
      }
      // THE LOCK (design 3.2 DOCUMENTED CHOICE): immutable once the first
      // turn has run -- runGraph persists the user_message as its first act,
      // so "has any event" is the honest turn-started signal. Enforced here,
      // main-side, so no renderer race can flip a mode an earlier turn's
      // system prompt already used. ipcMain.handle turns the throw into a
      // rejected promise (the set-builtin-disabled idiom).
      if (db.conversationHasEvents(id)) {
        throw new Error('Execution mode is locked after the first turn')
      }
      db.setExecutionMode(id, mode)
    }
  )
  ipcMain.handle('bearcode:conversations:clear', () => {
    clearRunsOrchestrator()
    // Prune each conversation's checkpoints before the rows are gone, so
    // checkpoints.db doesn't retain orphaned execution state after a wipe.
    for (const c of db.listConversations()) void pruneCheckpoints(c.id)
    db.clearAll()
  })

  ipcMain.handle('bearcode:permissions:add-rule', (_e, rule: AddRuleInput) => {
    addUserRule(rule)
  })
  ipcMain.handle('bearcode:permissions:list', () => listRulesInfo())
  ipcMain.handle('bearcode:permissions:delete-rule', (_e, id: string) => {
    deleteUserRule(id)
  })
  ipcMain.handle(
    'bearcode:permissions:set-builtin-disabled',
    (_e, id: string, disabled: boolean) => {
      // setBuiltinDisabled throws on an unknown builtin id (store.ts), which
      // ipcMain.handle turns into a rejected promise for the renderer -- the
      // renderer cannot silently "succeed" at disabling an id that doesn't exist.
      setBuiltinDisabled(id, disabled)
    }
  )

  ipcMain.handle('bearcode:workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
