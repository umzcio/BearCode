import { randomUUID } from 'crypto'
import { statSync, readFileSync } from 'fs'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AddRuleInput,
  AppSettings,
  ArtifactComment,
  CommandEntry,
  ConversationMeta,
  Event,
  HistoryHit,
  ManualRuleInfo,
  PingResult,
  PreviewPayload,
  ProjectSettings,
  ProviderId,
  RunState,
  TranscribeMeta,
  WorktreeInfo
} from '../shared/types'
import { isPermissionMode } from '../shared/permissionMode'
import { isEffortLevel } from '../shared/effort'
import { keyStatus, setKey } from './keys'
import { addUserRule, deleteUserRule, listRulesInfo, setBuiltinDisabled } from './permissions'
import { setSettings, settingsInfo } from './settings'
import { allKnownModelRefs, listAllModels, listManageableModels } from './providers/registry'
import { syncPricing } from './pricing/sync'
import { filePathFor, getDiff, revertFile } from './diffs'
import { transcribe } from './voice/transcribe'
import { previewClassify } from './preview/classify'
import { inlineHtmlAssets, injectPreviewNavGuard } from './preview/inlineHtml'
import { runOfficeHtml, runOfficeRows } from './attachments/office'
import { parseCsv } from './preview/csv'
import { extractTextLane } from './attachments/extract'
import * as db from './db'
import { createWorktrees, removeWorktrees, gitAvailable, discoverRepos } from './worktree/manager'
import {
  commitWorktree,
  mergeToBase,
  readConflict,
  writeResolved,
  completeMerge,
  abortMerge
} from './worktree/merge'
import { jailPath } from './orchestrator/fsBackend'
import { loadAgentsContent } from './agentsDir'
import { listCommands } from './orchestrator/commands'
import { suggestFiles, manualRuleInfos } from './orchestrator/mentionSuggest'
import {
  assertValidConversationId,
  ingestPickedFiles,
  readAttachmentDataUrl
} from './attachments/ingest'
import {
  assertValidAttachments,
  assertValidCommand,
  assertValidMentions,
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
      _projectPath: string | null,
      rawCommand?: unknown,
      rawMentions?: unknown,
      rawAttachments?: unknown
    ) => {
      // projectPath is already persisted on the conversation row (set at
      // creation); the orchestrator reads it back from getConversationMeta, so
      // nothing to stash here. assertValidCommand/assertValidMentions/
      // assertValidAttachments throw on anything looser than a well-formed
      // CommandRef/MentionRef[]/AttachmentRef[] (or null/undefined), which
      // ipcMain.handle turns into a rejected promise for the renderer -- BEFORE
      // any DB or model work happens (the assertValidPlanReviewResolution
      // posture). Fire and forget: progress flows back over bearcode:event.
      const command = assertValidCommand(rawCommand)
      const mentions = assertValidMentions(rawMentions)
      const attachments = assertValidAttachments(rawAttachments)
      void startRunOrchestrator(
        conversationId,
        userText,
        modelRef,
        sink,
        command,
        mentions,
        attachments
      )
    }
  )

  ipcMain.handle('bearcode:run:cancel', (_e, conversationId: string) => {
    cancelRunOrchestrator(conversationId)
  })

  ipcMain.handle('bearcode:models:list', () => listAllModels())

  ipcMain.handle('bearcode:models:manageable', () => listManageableModels())

  ipcMain.handle('bearcode:history:search', (_e, query: string): HistoryHit[] =>
    db.searchHistory(query)
  )

  // The slash menu's live read model (design 6.1/3.1), re-fetched on menu
  // open: loadAgentsContent is the same mtime-cached loader the turn-time
  // rule/command assembly uses, so this stays cheap on repeated opens.
  ipcMain.handle('bearcode:commands:list', (_e, projectPath: string | null): CommandEntry[] =>
    listCommands(loadAgentsContent(projectPath))
  )

  // D3 @ menu read models (design 7), mirroring commands:list. Files: a
  // gitignore-respecting, TTL-cached rg --files listing ranked against the
  // query. Rules: the live Manual-mode rules from the same mtime-cached loader.
  ipcMain.handle('bearcode:mentions:files', (_e, projectPath: string | null, query: string) =>
    suggestFiles(projectPath, query)
  )
  ipcMain.handle('bearcode:mentions:rules', (_e, projectPath: string | null): ManualRuleInfo[] =>
    manualRuleInfos(loadAgentsContent(projectPath))
  )

  // D4 Media (design 8): native image picker + main-side ingest. Returns the
  // accepted attachments (ref + a preview data URL for the composer thumbnail)
  // and a human-readable error per rejected file. Bytes are copied under
  // userData; only the ref later crosses run:start. `existingCount` lets the
  // 5-per-message cap consider images already on the composer.
  // SECURITY: conversationId is renderer-supplied and used main-side to build
  // an on-disk path; ingestPickedFiles validates it (path-safe grammar)
  // BEFORE any mkdir/write/read, so a malformed id rejects this promise
  // instead of ever touching the filesystem.
  ipcMain.handle(
    'bearcode:attachments:pick',
    async (_e, conversationId: string, existingCount: number) => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Attachments',
            extensions: [
              'png',
              'jpg',
              'jpeg',
              'webp',
              'gif',
              'pdf',
              'docx',
              'xlsx',
              'md',
              'markdown',
              'txt',
              'text',
              'html',
              'htm',
              'css',
              'js',
              'jsx',
              'mjs',
              'cjs',
              'ts',
              'tsx',
              'py',
              'json',
              'jsonc',
              'yaml',
              'yml',
              'toml',
              'ini',
              'xml',
              'csv',
              'tsv',
              'sh',
              'bash',
              'zsh',
              'rs',
              'go',
              'java',
              'kt',
              'c',
              'h',
              'cpp',
              'hpp',
              'cc',
              'rb',
              'php',
              'sql',
              'swift',
              'r',
              'lua',
              'pl'
            ]
          }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { picked: [], errors: [] }
      }
      return ingestPickedFiles(conversationId, result.filePaths, existingCount)
    }
  )

  // D4 Media (Task 7): transcript attachment thumbnail. A reloaded transcript
  // only has the persisted AttachmentRef (id/name/mime), never bytes, so the
  // pill's real image comes from here. SECURITY: conversationId/id are both
  // renderer-supplied path segments; readAttachmentDataUrl validates both
  // against their path-safe grammars BEFORE any read and throws (rejecting
  // this promise) on a mismatch instead of ever touching the filesystem.
  ipcMain.handle('bearcode:attachments:read', (_e, conversationId: string, id: string) =>
    readAttachmentDataUrl(conversationId, id)
  )

  ipcMain.handle('bearcode:diffs:get', (_e, diffId: string) => getDiff(diffId))
  ipcMain.handle('bearcode:diffs:revert', (_e, fileId: string) => revertFile(fileId))
  ipcMain.handle('bearcode:diffs:open', (_e, fileId: string) => {
    const path = filePathFor(fileId)
    if (path) void shell.openPath(path)
  })
  // E9b: read-only IDEAL rendered preview of a file's real content (path from
  // the DB via filePathFor -- never a raw renderer path). statSync's size-cap
  // runs BEFORE readFileSync (D4 OOM lesson). previewClassify's kind drives
  // the format-specific route below; docx/xlsx parsing stays behind the
  // killable worker (runOfficeHtml/runOfficeRows) -- mammoth/exceljs/unpdf
  // must never be re-imported into the main event loop here. docx HTML from
  // mammoth is unsanitized -- it is only ever handed to the renderer as
  // `{kind:'html'}`, which FilePreview renders in the existing sandboxed
  // (allow-scripts, opaque-origin) iframe, never dangerouslySetInnerHTML'd
  // directly into the app's own DOM.
  ipcMain.handle('bearcode:diffs:preview', async (_e, fileId: string): Promise<PreviewPayload> => {
    const path = filePathFor(fileId)
    if (!path) return { kind: 'unsupported', note: 'File not found' }
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      return { kind: 'unsupported', note: 'File not found' }
    }
    if (size > 10 * 1024 * 1024) return { kind: 'unsupported', note: 'File too large to preview' }
    try {
      const bytes = readFileSync(path)
      const c = previewClassify(path)
      if (c.kind === 'image') {
        const ext = (path.split('.').pop() ?? 'png').toLowerCase()
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
        return { kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
      }
      if (c.kind === 'svg') {
        return { kind: 'image', dataUrl: `data:image/svg+xml;base64,${bytes.toString('base64')}` }
      }
      if (c.kind === 'pdf') {
        return { kind: 'pdf', dataUrl: `data:application/pdf;base64,${bytes.toString('base64')}` }
      }
      if (c.kind === 'docx') {
        const html = await runOfficeHtml(bytes)
        return html
          ? { kind: 'html', html }
          : { kind: 'unsupported', note: 'Could not render document' }
      }
      if (c.kind === 'xlsx') {
        const rows = await runOfficeRows(bytes)
        return rows
          ? { kind: 'table', rows }
          : { kind: 'unsupported', note: 'Could not render spreadsheet' }
      }
      if (c.kind === 'markdown') {
        return { kind: 'markdown', text: bytes.toString('utf8') }
      }
      if (c.kind === 'csv') {
        return { kind: 'table', rows: parseCsv(bytes.toString('utf8')) }
      }
      if (c.kind === 'json') {
        const text = bytes.toString('utf8')
        let pretty = text
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          pretty = text
        }
        return { kind: 'code', text: pretty, language: 'json' }
      }
      if (c.kind === 'code') {
        return { kind: 'code', text: bytes.toString('utf8'), language: c.language ?? 'plaintext' }
      }
      if (c.kind === 'html') {
        // Inline local sibling CSS/JS so the blob-URL preview iframe renders
        // styled, then inject the (CSP-hash-allowed) anchor scroll guard so
        // in-page "#" links scroll instead of doing nothing.
        return {
          kind: 'html',
          html: injectPreviewNavGuard(inlineHtmlAssets(bytes.toString('utf8'), path))
        }
      }
      const r = extractTextLane(bytes)
      return { kind: 'text', text: r.text, truncated: r.truncated }
    } catch {
      // Read/extraction failed after the stat (deleted mid-flight, unreadable) —
      // return a payload rather than rejecting so the pane never hangs.
      return { kind: 'unsupported', note: 'Could not read file' }
    }
  })
  // E10: Cmd-click a file reference (DiffCard row / Changes pane tab) to open
  // it in the OS default app. jailPath throws if the resolved path escapes
  // the conversation's workspace root -- NEVER shell.openPath a raw
  // renderer-supplied path.
  ipcMain.handle('bearcode:shell:open-file', (_e, conversationId: string, path: string) => {
    const meta = db.getConversationMeta(conversationId)
    if (!meta?.projectPath) throw new Error('No workspace folder for this conversation')
    const abs = jailPath(meta.projectPath, path)
    void shell.openPath(abs)
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

  // User-initiated pricing sync (Settings "Sync prices" button). Runs in main
  // only -- keeps the LiteLLM fetch off the renderer/CSP surface. Persists the
  // resolved prices + a syncedAt stamp; throws propagate to the UI.
  ipcMain.handle('bearcode:pricing:sync', async () => {
    const refs = allKnownModelRefs()
    const { prices, unmatched } = await syncPricing(refs)
    const syncedAt = Date.now()
    setSettings({ modelPricing: prices, modelPricingSyncedAt: syncedAt })
    return { syncedCount: Object.keys(prices).length, unmatched, syncedAt }
  })

  ipcMain.handle('bearcode:conversations:list', () => db.listConversations())
  ipcMain.handle('bearcode:conversations:get', (_e, id: string) => db.getEvents(id))
  // D4 draft-id flow: Home's composer mints a client-side id (crypto.randomUUID(),
  // which satisfies this grammar) so Media attachments picked before the first
  // send land under the SAME id the conversation is created with. SECURITY: id
  // is renderer-supplied and becomes the conversations.id primary key (and, via
  // the attachments dir, a filesystem path segment) -- validated against the
  // same grammar attachments:pick enforces BEFORE it ever reaches the DB.
  ipcMain.handle('bearcode:conversations:create', (_e, projectPath: string | null, id?: string) => {
    if (id !== undefined) assertValidConversationId(id)
    return db.createConversation(projectPath, id)
  })
  ipcMain.handle('bearcode:conversations:delete', async (_e, id: string) => {
    forgetRunOrchestrator(id)
    // F3: a worktree conversation owns a worktree dir under userData PLUS a
    // bearcode/* branch + worktree registration in the user's repo. Deleting it
    // must reclaim them (design: delete → removeWorktrees), or the orphaned
    // branch bricks future worktree creation for that project. Read meta BEFORE
    // deleteConversation drops the row.
    const meta = db.getConversationMeta(id)
    if (meta && meta.worktrees.length > 0) {
      await removeWorktrees(meta.worktrees)
    }
    void pruneCheckpoints(id)
    db.deleteConversation(id)
  })
  ipcMain.handle('bearcode:conversations:set-mode', (_e, id: string, mode: unknown) => {
    if (!isPermissionMode(mode)) {
      throw new Error(`Invalid permission mode: ${String(mode)}`)
    }
    db.setPermissionMode(id, mode)
  })
  ipcMain.handle('bearcode:conversations:set-effort', (_e, id: string, effort: unknown) => {
    if (!isEffortLevel(effort)) {
      throw new Error(`Invalid effort: ${String(effort)}`)
    }
    db.setEffort(id, effort)
  })
  ipcMain.handle('bearcode:conversations:set-thinking', (_e, id: string, thinking: unknown) => {
    if (typeof thinking !== 'boolean') {
      throw new Error(`Invalid thinking: ${String(thinking)}`)
    }
    db.setThinking(id, thinking)
  })
  // F3: env is chosen at create and locked at first run. The renderer calls
  // set-environment on the just-created conversation BEFORE the first run.
  // Worktree provisioning (the `git worktree add`) happens here, main-side, so
  // the renderer never shells out. A non-git project yields no worktrees and is
  // recorded honestly as local.
  ipcMain.handle(
    'bearcode:conversations:set-environment',
    async (_e, id: string, environment: unknown) => {
      if (environment !== 'local' && environment !== 'worktree') {
        throw new Error(`Invalid environment: ${String(environment)}`)
      }
      const meta = db.getConversationMeta(id)
      if (!meta) throw new Error(`Unknown conversation: ${id}`)
      if (environment === 'local' || !meta.projectPath) {
        db.setEnvironment(id, 'local', [])
        return db.getConversationMeta(id)
      }
      if (!(await gitAvailable())) {
        throw new Error(
          'Git is not available on this system, so Worktree mode is unavailable. Install git or use Local.'
        )
      }
      const app = (await import('electron')).app
      // The branch is bearcode/<slug>; the title is null at create (both create
      // paths make untitled conversations), so a title-only slug would be
      // 'work' for EVERY worktree conversation in a project and the second
      // `git worktree add -b bearcode/work` would fail. Fold a convId fragment
      // into the slug so each conversation gets a unique branch.
      const slug = `${meta.title ?? 'work'} ${id.slice(0, 8)}`
      const worktrees = await createWorktrees(app.getPath('userData'), id, meta.projectPath, slug)
      // A non-git project yields no worktrees: record honestly as local.
      db.setEnvironment(id, worktrees.length > 0 ? 'worktree' : 'local', worktrees)
      return db.getConversationMeta(id)
    }
  )
  ipcMain.handle('bearcode:worktree:discard', async (_e, convId: string) => {
    const meta = db.getConversationMeta(convId)
    if (!meta) return
    await removeWorktrees(meta.worktrees)
    db.setEnvironment(convId, 'local', [])
  })
  // F3: per-repo merge flow. Each handler resolves the conversation meta, finds
  // the WorktreeInfo for the given repoPath (throwing a clear error if missing),
  // then drives the merge engine — merges run in the base repo, per-repo so
  // multi-repo merges stay independent.
  const findWorktree = (convId: string, repoPath: string): WorktreeInfo => {
    const meta = db.getConversationMeta(convId)
    const w = meta?.worktrees.find((x) => x.repoPath === repoPath)
    if (!w) throw new Error(`No worktree for repo ${repoPath} in conversation ${convId}`)
    return w
  }
  ipcMain.handle('bearcode:worktree:merge', async (_e, convId: string, repoPath: string) => {
    const w = findWorktree(convId, repoPath)
    await commitWorktree(w, `BearCode: merge conversation ${convId}`)
    return mergeToBase(w)
  })
  ipcMain.handle(
    'bearcode:worktree:read-conflict',
    (_e, convId: string, repoPath: string, file: string) =>
      readConflict(findWorktree(convId, repoPath), file)
  )
  ipcMain.handle(
    'bearcode:worktree:resolve-file',
    (_e, convId: string, repoPath: string, file: string, content: unknown) => {
      if (typeof content !== 'string') throw new Error('Invalid resolved content')
      return writeResolved(findWorktree(convId, repoPath), file, content)
    }
  )
  ipcMain.handle('bearcode:worktree:complete-merge', (_e, convId: string, repoPath: string) =>
    completeMerge(findWorktree(convId, repoPath))
  )
  ipcMain.handle('bearcode:worktree:abort', (_e, convId: string, repoPath: string) =>
    abortMerge(findWorktree(convId, repoPath))
  )
  // F3: New-Worktree mode is offerable only when git is present AND the folder
  // (or an immediate child) is a git repo — mirrors createWorktrees' discovery.
  ipcMain.handle('bearcode:worktree:available', async (_e, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) return false
    try {
      return (await gitAvailable()) && discoverRepos(path).length > 0
    } catch {
      return false
    }
  })
  // F9 (folder = project): per-folder settings keyed by workspace path. `list`
  // returns only folders that carry a stored settings row. `update` upserts the
  // row (the DB layer coerces effort/mode enums + non-string values) and returns
  // the resulting FolderProject.
  ipcMain.handle('bearcode:projects:list', () => db.listProjectSettings())
  ipcMain.handle('bearcode:projects:update', (_e, path: unknown, patch: unknown) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`Invalid project path: ${String(path)}`)
    }
    if (patch == null || typeof patch !== 'object') {
      throw new Error('Invalid project settings patch')
    }
    db.upsertProjectSettings(path, patch as ProjectSettings)
    return db.getProjectSettings(path)
  })
  ipcMain.handle('bearcode:conversations:set-pinned', (_e, id: string, pinned: unknown) => {
    if (typeof pinned !== 'boolean') throw new Error(`Invalid pinned: ${String(pinned)}`)
    db.setPinned(id, pinned)
  })
  ipcMain.handle('bearcode:conversations:set-archived', (_e, id: string, archived: unknown) => {
    if (typeof archived !== 'boolean') throw new Error(`Invalid archived: ${String(archived)}`)
    db.setArchived(id, archived)
  })
  ipcMain.handle('bearcode:conversations:rename', (_e, id: string, title: unknown) => {
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error(`Invalid conversation title: ${String(title)}`)
    }
    db.setTitle(id, title.trim())
  })
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

  // Voice input (E5): the composer records mic audio and hands the ArrayBuffer
  // here; transcription runs MAIN-side only so the renderer never holds an API
  // key. `meta.kind` selects the payload/backend: 'webm' (raw container →
  // OpenAI Whisper) or 'pcm' (renderer-decoded 16 kHz mono float → local
  // Whisper). `transcribe` hard-routes on that tag.
  ipcMain.handle(
    'bearcode:voice:transcribe',
    async (_e, audio: ArrayBuffer, meta: TranscribeMeta): Promise<{ text: string }> =>
      transcribe(audio, meta)
  )

  ipcMain.handle('bearcode:workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
