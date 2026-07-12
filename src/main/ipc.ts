import { randomUUID } from 'crypto'
import { statSync, readFileSync } from 'fs'
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type {
  AddRuleInput,
  AppSettings,
  ArtifactComment,
  CommandEntry,
  ConversationMeta,
  DiscoveredMcpServer,
  Event,
  GithubDeviceStart,
  HistoryHit,
  IntegrationProvider,
  IntegrationStatus,
  ManualRuleInfo,
  McpServerConfig,
  McpServerStatus,
  McpServerView,
  MarketplacePlugin,
  MemoryList,
  MemoryPromoteInput,
  MemoryScopeName,
  PingResult,
  PluginEntry,
  PluginManifest,
  PreviewPayload,
  ProjectSettings,
  ProviderId,
  PromoteTarget,
  RunState,
  SkillEntry,
  SkillInfo,
  SkillInput,
  SkillProposalResolution,
  SkillSaveResult,
  TranscribeMeta,
  WorktreeInfo
} from '../shared/types'
import { isPermissionMode } from '../shared/permissionMode'
import { isEffortLevel } from '../shared/effort'
import { keyStatus, setKey, setVaultSecret } from './keys'
import {
  loadServers as loadMcpServers,
  upsertServer as upsertMcpServer,
  removeServer as removeMcpServer,
  isEnabled as isMcpServerEnabled,
  setEnabled as setMcpServerEnabled,
  isTrusted as isMcpServerTrusted,
  trustProjectServer as trustMcpProjectServer,
  markGlobalServerUntrusted as markGlobalMcpServerUntrusted,
  trustGlobalServer as trustGlobalMcpServer,
  trustPluginServer as trustMcpPluginServer,
  untrustPluginServer as untrustMcpPluginServer,
  hasSpawnConsent as hasMcpSpawnConsent,
  grantSpawnConsent as grantMcpSpawnConsent,
  discoverLocalServers,
  invalidateStaleConsentOnImport
} from './mcp/store'
import { mcpManager } from './mcp/manager'
import { smitherySearch, fetchSmitheryConfig } from './mcp/registry'
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
import { browserManager } from './browser/manager'
import {
  commitWorktree,
  mergeToBase,
  readConflict,
  writeResolved,
  completeMerge,
  abortMerge
} from './worktree/merge'
import {
  getIntegration,
  setIntegration,
  saveIntegrationToken,
  disconnect as disconnectIntegration
} from './integrations/store'
import {
  githubDeviceStart,
  githubDevicePoll,
  githubConnectPat,
  cancelGithubDevice
} from './integrations/github'
import { bitbucketConnect } from './integrations/bitbucket'
import { gitAuthEnv } from './integrations/gitCredentials'
import { setGitCredentialResolver } from './worktree/git'
import { jailPath } from './orchestrator/fsBackend'
import { hasProjectAgentsConfig, loadAgentsContent } from './agentsDir'
import { listCommands } from './orchestrator/commands'
import { suggestFiles, manualRuleInfos, skillInfos } from './orchestrator/mentionSuggest'
import { createSkill, deleteSkillFolder, listSkillEntries, updateSkill } from './skills'
import { isSkillEnabled, setSkillEnabled } from './skills/state'
import { listMemory, addMemory, updateMemory, deleteMemory, promoteMemory } from './memory'
import { listPlugins, uninstallPlugin } from './plugins'
import { setPluginEnabled } from './plugins/state'
import * as pluginMarket from './plugins/marketplace'
import {
  validateScope as validatePluginScope,
  validateName as validatePluginName
} from './plugins/validate'
import { COMMAND_NAME_PATTERN } from '../shared/types'
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
  resolveSkillProposalOrchestrator,
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
  // Wire git-over-HTTPS credential injection into the worktree/git runner: any
  // network git subcommand (clone/fetch/pull/push) against github.com/
  // bitbucket.org now authenticates with the connected integration's vaulted
  // token via a per-invocation GIT_ASKPASS helper. gitAuthEnv returns `{}` for
  // unconnected/unknown hosts, so local ops are unaffected. Registered once at
  // main startup (mirrors the browserManager/mcpManager provider-wiring seam).
  setGitCredentialResolver(gitAuthEnv)

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
    listCommands(
      loadAgentsContent(projectPath, {
        trusted: projectPath != null && db.isProjectTrusted(projectPath)
      })
    )
  )

  // D3 @ menu read models (design 7), mirroring commands:list. Files: a
  // gitignore-respecting, TTL-cached rg --files listing ranked against the
  // query. Rules: the live Manual-mode rules from the same mtime-cached loader.
  ipcMain.handle('bearcode:mentions:files', (_e, projectPath: string | null, query: string) =>
    suggestFiles(projectPath, query)
  )
  ipcMain.handle('bearcode:mentions:rules', (_e, projectPath: string | null): ManualRuleInfo[] =>
    manualRuleInfos(
      loadAgentsContent(projectPath, {
        trusted: projectPath != null && db.isProjectTrusted(projectPath)
      })
    )
  )
  ipcMain.handle('bearcode:mentions:skills', (_e, projectPath: string | null): SkillInfo[] => {
    const content = loadAgentsContent(projectPath, {
      trusted: projectPath != null && db.isProjectTrusted(projectPath)
    })
    return skillInfos(content).filter((info) => {
      const src = content.skills.find((k) => k.name === info.name)?.source ?? 'global'
      return isSkillEnabled(info.name, src, projectPath)
    })
  })

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
  const reqPath = (p: unknown): string => {
    if (typeof p !== 'string' || p.length === 0)
      throw new Error(`Invalid project path: ${String(p)}`)
    return p
  }
  ipcMain.handle('bearcode:project:is-trusted', (_e, p: unknown) => db.isProjectTrusted(reqPath(p)))
  ipcMain.handle('bearcode:project:trust', (_e, p: unknown) => {
    const path = reqPath(p)
    db.trustProject(path)
    return db.getProjectSettings(path)
  })
  ipcMain.handle('bearcode:project:untrust', (_e, p: unknown) => {
    const path = reqPath(p)
    db.untrustProject(path)
    return db.getProjectSettings(path)
  })
  ipcMain.handle('bearcode:project:has-config', (_e, p: unknown) =>
    hasProjectAgentsConfig(reqPath(p))
  )
  ipcMain.handle('bearcode:project:outside-access:get', (_e, p: unknown) =>
    db.listOutsidePaths(reqPath(p))
  )
  ipcMain.handle('bearcode:project:outside-access:set', (_e, p: unknown, pol: unknown) => {
    const path = reqPath(p)
    if (pol !== 'allow' && pol !== 'ask' && pol !== 'deny')
      throw new Error(`Invalid policy: ${String(pol)}`)
    db.setOutsideFolderPolicy(path, pol)
    return db.listOutsidePaths(path)
  })
  ipcMain.handle('bearcode:project:outside-access:allow', (_e, p: unknown, abs: unknown) => {
    const path = reqPath(p)
    db.allowOutsidePath(path, reqPath(abs))
    return db.listOutsidePaths(path)
  })
  ipcMain.handle('bearcode:project:outside-access:deny', (_e, p: unknown, abs: unknown) => {
    const path = reqPath(p)
    db.denyOutsidePath(path, reqPath(abs))
    return db.listOutsidePaths(path)
  })
  ipcMain.handle('bearcode:project:outside-access:list', (_e, p: unknown) =>
    db.listOutsidePaths(reqPath(p))
  )
  ipcMain.handle('bearcode:project:outside-access:remove', (_e, p: unknown, abs: unknown) => {
    const path = reqPath(p)
    db.removeOutsidePath(path, reqPath(abs))
    return db.listOutsidePaths(path)
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

  // F4: browser pane geometry + lifecycle. The WebContentsView is a main-side
  // singleton (browserManager); the renderer only reports the placeholder
  // rect's bounds and toggles visibility on mount/unmount. `status` backs the
  // Settings Browser tab; `clear-session` wipes per-conversation browsing data.
  ipcMain.handle('bearcode:browser:status', () => browserManager.status())
  ipcMain.handle('bearcode:browser:clear-session', () => browserManager.clearSession())
  ipcMain.handle(
    'bearcode:browser:set-bounds',
    (_e, b: { x: number; y: number; width: number; height: number }) => {
      browserManager.setBounds(b)
    }
  )
  ipcMain.handle('bearcode:browser:show', () => browserManager.show())

  // MCP (Connectors): global+project config CRUD, enable/trust/spawn-consent
  // state, live status, and secrets. `status` in the returned McpServerView
  // prioritizes 'untrusted' over 'disabled' -- a committed-project server the
  // user hasn't trusted yet shows the trust prompt regardless of its toggle
  // (design 2026-07-09-connectors-mcp-design.md section 6). smitherySearch/
  // smitheryInstall are wired here but throw until Tasks 11/12 land the
  // registry client.
  const mcpServerView = (cfg: McpServerConfig, projectPath: string | null): McpServerView => {
    const enabled = isMcpServerEnabled(cfg.name)
    const trusted = isMcpServerTrusted(cfg.name, cfg.source, projectPath, cfg.plugin)
    const status: McpServerStatus = !trusted
      ? { state: 'untrusted' }
      : !enabled
        ? { state: 'disabled' }
        : mcpManager.statusOf(cfg.name)
    return { config: cfg, enabled, status, spawnConsented: hasMcpSpawnConsent(cfg.name) }
  }
  const asProjectPath = (x: unknown): string | null => (typeof x === 'string' ? x : null)

  // Moves every non-empty header/env value that isn't already a ${VAULT:} ref
  // into the encrypted vault and returns the map with each such value replaced
  // by its reference. Guarantees the persisted mcp.json never carries a
  // plaintext secret (design §2). Values are keyed `mcp:<server>:<section>:<k>`.
  const VAULT_REF_RE = /^\$\{VAULT:[^}]+\}$/
  const scrubMcpSecretsToVault = (
    server: string,
    section: 'headers' | 'env',
    values: Record<string, string> | undefined
  ): Record<string, string> | undefined => {
    if (!values) return values
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== 'string' || v.length === 0 || VAULT_REF_RE.test(v)) {
        out[k] = v
        continue
      }
      const vaultKey = `mcp:${server}:${section}:${k}`
      setVaultSecret(vaultKey, v)
      out[k] = `\${VAULT:${vaultKey}}`
    }
    return out
  }

  ipcMain.handle('bearcode:mcp:list', (_e, projectPath: unknown) => {
    const proj = asProjectPath(projectPath)
    return loadMcpServers(proj).map((cfg) => mcpServerView(cfg, proj))
  })
  // Like list, but first (non-interactively) connects any enabled+trusted
  // server that's idle, so opening the Connectors page / @-menu surfaces
  // enabled connectors with real status instead of a stale "not connected".
  ipcMain.handle('bearcode:mcp:ensure-connected', async (_e, projectPath: unknown) => {
    const proj = asProjectPath(projectPath)
    await mcpManager.ensureEnabledConnected(proj)
    return loadMcpServers(proj).map((cfg) => mcpServerView(cfg, proj))
  })
  ipcMain.handle('bearcode:mcp:add', (_e, cfg: unknown, projectPath: unknown) => {
    if (cfg == null || typeof cfg !== 'object') {
      throw new Error(`Invalid MCP server config: ${String(cfg)}`)
    }
    const c = cfg as Partial<McpServerConfig>
    if (typeof c.name !== 'string' || c.name.trim().length === 0) {
      throw new Error('MCP server config is missing a name')
    }
    if (c.transport !== 'http' && c.transport !== 'stdio') {
      throw new Error(`Invalid MCP transport: ${String(c.transport)}`)
    }
    if (c.source !== 'global' && c.source !== 'project') {
      throw new Error(`Invalid MCP server source: ${String(c.source)}`)
    }
    // No plaintext secret ever lands in mcp.json (design §2). Any header/env
    // value the user typed that isn't ALREADY a ${VAULT:} reference is moved
    // into the encrypted vault and replaced with a reference before we persist
    // -- so the committed/synced file only ever carries indirections. This is
    // the manual-add flow's vault path (previously absent, so plaintext tokens
    // were written verbatim).
    const scrubbed: McpServerConfig = {
      ...(c as McpServerConfig),
      name: c.name.trim(),
      headers: scrubMcpSecretsToVault(c.name.trim(), 'headers', c.headers),
      env: scrubMcpSecretsToVault(c.name.trim(), 'env', c.env)
    }
    upsertMcpServer(scrubbed, asProjectPath(projectPath))
  })
  ipcMain.handle(
    'bearcode:mcp:remove',
    (_e, name: unknown, source: unknown, projectPath: unknown) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`Invalid MCP server name: ${String(name)}`)
      }
      if (source !== 'global' && source !== 'project') {
        throw new Error(`Invalid MCP server source: ${String(source)}`)
      }
      removeMcpServer(name, source, asProjectPath(projectPath))
    }
  )
  ipcMain.handle(
    'bearcode:mcp:set-enabled',
    async (_e, name: unknown, on: unknown, projectPath: unknown) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`Invalid MCP server name: ${String(name)}`)
      }
      if (typeof on !== 'boolean') throw new Error(`Invalid MCP enabled flag: ${String(on)}`)
      setMcpServerEnabled(name, on)
      if (!on) {
        await mcpManager.teardown(name)
        return mcpManager.statusOf(name)
      }
      // Pass the project path so a project-scoped server actually resolves via
      // loadServers(projectPath) -- enabling with a hardcoded null read GLOBAL
      // only and failed every committed-project server with "unknown MCP
      // server" (the entire project class could only be launched via Reconnect).
      return mcpManager.enable(name, asProjectPath(projectPath))
    }
  )
  ipcMain.handle('bearcode:mcp:trust', (_e, name: unknown, projectPath: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    if (typeof projectPath !== 'string' || projectPath.length === 0) {
      throw new Error(`Invalid project path: ${String(projectPath)}`)
    }
    trustMcpProjectServer(name, projectPath)
    return mcpManager.statusOf(name)
  })
  ipcMain.handle('bearcode:mcp:spawn-consent', (_e, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    grantMcpSpawnConsent(name)
  })
  ipcMain.handle('bearcode:mcp:reconnect', (_e, name: unknown, projectPath: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    return mcpManager.reconnect(name, asProjectPath(projectPath))
  })
  ipcMain.handle('bearcode:mcp:authorize', (_e, name: unknown, projectPath: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    return mcpManager.authorize(name, asProjectPath(projectPath))
  })
  ipcMain.handle('bearcode:mcp:status', (_e, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    return mcpManager.statusOf(name)
  })
  ipcMain.handle('bearcode:mcp:set-secret', (_e, vaultKey: unknown, value: unknown) => {
    if (typeof vaultKey !== 'string' || vaultKey.length === 0) {
      throw new Error(`Invalid vault key: ${String(vaultKey)}`)
    }
    if (typeof value !== 'string') throw new Error(`Invalid secret value: ${String(value)}`)
    setVaultSecret(vaultKey, value)
  })
  // Task 12: wires the Task 11 registry client (smitherySearch/
  // fetchSmitheryConfig) into the store. Install writes the fetched config via
  // upsertMcpServer -- its required-field ${VAULT:} placeholders (registry.ts)
  // are already vault refs, not plaintext, so they pass scrubMcpSecretsToVault
  // unchanged; the renderer prompts the user to fill each one via
  // `mcp.setSecret` after install (see BrowseSmitheryModal).
  ipcMain.handle('bearcode:mcp:smithery-search', (_e, query: unknown) => {
    if (typeof query !== 'string') throw new Error(`Invalid Smithery query: ${String(query)}`)
    return smitherySearch(query)
  })
  ipcMain.handle('bearcode:mcp:smithery-install', async (_e, id: unknown, projectPath: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Invalid Smithery server id: ${String(id)}`)
    }
    const proj = asProjectPath(projectPath)
    // A Smithery config's url/command comes from the registry response, not from
    // the user -- so it must NOT connect until the user passes the L2 trust gate,
    // regardless of scope. With a project open we install it project-scoped
    // (already trust-gated via mcpTrustedProjectServers -> starts untrusted).
    // Without one it is global; globals are trusted by default, so we explicitly
    // mark it untrusted so a malicious deploymentUrl can't SSRF on enable.
    const source: 'global' | 'project' = proj ? 'project' : 'global'
    const cfg = await fetchSmitheryConfig(id, source)
    upsertMcpServer(cfg, proj)
    if (source === 'global') markGlobalMcpServerUntrusted(cfg.name)
    return mcpServerView(cfg, proj)
  })
  // The user's explicit trust opt-in for a global server pending trust (a
  // Smithery global install). Project-scoped trust goes through
  // 'bearcode:mcp:trust' instead. Kept separate so the renderer can trust a
  // global server without a project path.
  ipcMain.handle('bearcode:mcp:trust-global', (_e, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    trustGlobalMcpServer(name)
    return mcpManager.statusOf(name)
  })
  // The user's explicit trust opt-in / revocation for a plugin-sourced server
  // (untrusted by default regardless of scope -- see store.ts isTrusted's
  // `plugin` branch). Keyed on the plugin-qualified name, mirroring
  // trustPluginServer/untrustPluginServer in store.ts.
  ipcMain.handle('bearcode:mcp:trust-plugin', (_e, plugin: unknown, name: unknown) => {
    if (typeof plugin !== 'string' || plugin.length === 0) {
      throw new Error(`Invalid plugin name: ${String(plugin)}`)
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    trustMcpPluginServer(plugin, name)
    return mcpManager.statusOf(name)
  })
  ipcMain.handle('bearcode:mcp:untrust-plugin', async (_e, plugin: unknown, name: unknown) => {
    if (typeof plugin !== 'string' || plugin.length === 0) {
      throw new Error(`Invalid plugin name: ${String(plugin)}`)
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid MCP server name: ${String(name)}`)
    }
    untrustMcpPluginServer(plugin, name)
    await mcpManager.teardown(name)
    return mcpManager.statusOf(name)
  })

  // Task 13: read-only discovery of MCP servers already configured elsewhere
  // (a project's `.mcp.json`, the Claude Desktop config). Pure read -- never
  // mutates the source files, degrades to [] on missing/malformed JSON.
  ipcMain.handle('bearcode:mcp:discover', (_e, projectPath: unknown) => {
    return discoverLocalServers(asProjectPath(projectPath))
  })
  // Imports the user's picked subset of discovered servers through the SAME
  // store.upsertServer path as manual add / Smithery install -- never a side
  // path (design §11). Secrets are NEVER auto-copied from a foreign config:
  // header/env VALUES are dropped (keys kept) so the user must fill each one
  // in via mcp.setSecret before the server can actually authenticate. Imported
  // servers land under the SAME trust/consent/enable gates as any other: a
  // project-mcp-json-origin import is written project-scoped (so it starts
  // `untrusted` like any committed-project server), a stdio server still
  // needs spawn consent on first enable, and nothing here touches
  // mcpEnabledServers.
  ipcMain.handle('bearcode:mcp:import', (_e, servers: unknown, projectPath: unknown) => {
    if (!Array.isArray(servers)) {
      throw new Error(`Invalid discovered servers: ${String(servers)}`)
    }
    const proj = asProjectPath(projectPath)
    const blankValues = (o?: Record<string, string>): Record<string, string> | undefined =>
      o ? Object.fromEntries(Object.keys(o).map((k) => [k, ''])) : undefined
    const imported: McpServerView[] = []
    for (const raw of servers as unknown[]) {
      if (raw == null || typeof raw !== 'object') continue
      const d = raw as Partial<DiscoveredMcpServer>
      if (typeof d.name !== 'string' || d.name.trim().length === 0) continue
      if (d.transport !== 'http' && d.transport !== 'stdio') continue
      const name = d.name.trim()
      const source: 'global' | 'project' =
        d.origin === 'project-mcp-json' && proj ? 'project' : 'global'
      const cfg: McpServerConfig = {
        name,
        transport: d.transport,
        source,
        url: d.url,
        headers: blankValues(d.headers),
        command: d.command,
        args: d.args,
        env: blankValues(d.env)
      }
      // An import can bind this foreign config to a NAME whose trust/enable/
      // spawn-consent state already exists (that state is name-keyed). If the
      // incoming command/url differs from what that name already runs, drop the
      // stale consent BEFORE persisting so the spawn-consent + Trust gates
      // re-fire against the real new command instead of being silently inherited
      // (G3 review findings 1 & 2).
      invalidateStaleConsentOnImport(cfg, proj)
      upsertMcpServer(cfg, proj)
      imported.push(mcpServerView(cfg, proj))
    }
    return imported
  })

  // Integrations (GitHub/Bitbucket, Task 11): status read model + connect/
  // disconnect. NO token ever crosses this IPC -- githubDeviceStart/Poll,
  // githubConnectPat and bitbucketConnect only ever return the account
  // login/scopes; the raw token is vaulted here (saveIntegrationToken) and
  // never returned to the renderer, matching mcp:set-secret's write-only
  // contract.
  ipcMain.handle('bearcode:integrations:status', (): IntegrationStatus[] => {
    return (['github', 'bitbucket'] satisfies IntegrationProvider[]).map((p) => getIntegration(p))
  })

  ipcMain.handle(
    'bearcode:integrations:github-device-start',
    async (): Promise<GithubDeviceStart> => githubDeviceStart()
  )

  ipcMain.handle(
    'bearcode:integrations:github-device-poll',
    async (_e, deviceCode: unknown, interval: unknown): Promise<IntegrationStatus> => {
      if (typeof deviceCode !== 'string' || typeof interval !== 'number') {
        throw new Error('Invalid GitHub device-poll arguments.')
      }
      const { token, login, scopes } = await githubDevicePoll(deviceCode, interval)
      saveIntegrationToken('github', { token })
      const state: IntegrationStatus = {
        provider: 'github',
        connected: true,
        method: 'device',
        login,
        scopes,
        connectedAt: Date.now()
      }
      setIntegration('github', state)
      return state
    }
  )

  ipcMain.handle('bearcode:integrations:cancel-github-device', (_e, deviceCode: unknown) => {
    if (typeof deviceCode === 'string') cancelGithubDevice(deviceCode)
  })

  ipcMain.handle(
    'bearcode:integrations:github-connect-pat',
    async (_e, token: unknown): Promise<IntegrationStatus> => {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('A GitHub personal access token is required.')
      }
      const trimmed = token.trim()
      const { login, scopes } = await githubConnectPat(trimmed)
      saveIntegrationToken('github', { token: trimmed })
      const state: IntegrationStatus = {
        provider: 'github',
        connected: true,
        method: 'pat',
        login,
        scopes,
        connectedAt: Date.now()
      }
      setIntegration('github', state)
      return state
    }
  )

  ipcMain.handle(
    'bearcode:integrations:connect-bitbucket',
    async (_e, username: unknown, appPassword: unknown): Promise<IntegrationStatus> => {
      if (
        typeof username !== 'string' ||
        username.trim().length === 0 ||
        typeof appPassword !== 'string' ||
        appPassword.trim().length === 0
      ) {
        throw new Error('A Bitbucket username and app password are required.')
      }
      const trimmedUser = username.trim()
      const trimmedPass = appPassword.trim()
      const { username: canonical } = await bitbucketConnect(trimmedUser, trimmedPass)
      saveIntegrationToken('bitbucket', { token: trimmedPass })
      const state: IntegrationStatus = {
        provider: 'bitbucket',
        connected: true,
        method: 'app-password',
        login: canonical,
        connectedAt: Date.now()
      }
      setIntegration('bitbucket', state)
      return state
    }
  )

  ipcMain.handle('bearcode:integrations:disconnect', (_e, provider: unknown) => {
    if (provider !== 'github' && provider !== 'bitbucket') {
      throw new Error(`Invalid integration provider: ${String(provider)}`)
    }
    disconnectIntegration(provider)
  })

  function assertValidSkillInput(raw: unknown): SkillInput {
    if (raw == null || typeof raw !== 'object') throw new Error('Invalid skill input.')
    const r = raw as Partial<SkillInput>
    if (typeof r.name !== 'string' || !COMMAND_NAME_PATTERN.test(r.name)) {
      throw new Error('Skill name must be kebab-case.')
    }
    if (typeof r.description !== 'string' || r.description.trim() === '') {
      throw new Error('Skill description is required.')
    }
    if (typeof r.body !== 'string') throw new Error('Skill body must be a string.')
    if (r.scope !== 'global' && r.scope !== 'project') throw new Error('Invalid skill scope.')
    return { name: r.name, description: r.description, body: r.body, scope: r.scope }
  }

  // Wire-boundary guard for bearcode:skills:save's resolution argument (G-skills
  // Task 8), the propose_skill twin of assertValidPlanReviewResolution: reject
  // anything looser than the truthy-object contract BEFORE it ever reaches
  // resolveSkillProposalOrchestrator -> resolveSkillProposalInterrupt, which
  // treats `resolution` as already-trusted.
  function assertValidSkillResolution(raw: unknown): SkillProposalResolution {
    if (raw == null || typeof raw !== 'object') throw new Error('Invalid skill resolution.')
    const r = raw as Partial<{
      save: unknown
      name: unknown
      description: unknown
      body: unknown
      scope: unknown
    }>
    if (r.save === false) return { save: false }
    if (r.save !== true) throw new Error('resolveSkillProposal: save must be a boolean')
    if (typeof r.name !== 'string' || !COMMAND_NAME_PATTERN.test(r.name)) {
      throw new Error('Skill name must be kebab-case.')
    }
    if (typeof r.description !== 'string' || r.description.trim() === '') {
      throw new Error('Skill description is required.')
    }
    if (typeof r.body !== 'string') throw new Error('Skill body must be a string.')
    if (r.scope !== 'global' && r.scope !== 'project') throw new Error('Invalid skill scope.')
    return { save: true, name: r.name, description: r.description, body: r.body, scope: r.scope }
  }

  const asMemoryScope = (x: unknown): MemoryScopeName => {
    if (x !== 'global' && x !== 'project') throw new Error('Invalid memory scope.')
    return x
  }
  const asMemoryIndex = (x: unknown): number => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0)
      throw new Error('Invalid memory index.')
    return x
  }
  function assertValidPromoteInput(raw: unknown): MemoryPromoteInput {
    if (raw == null || typeof raw !== 'object') throw new Error('Invalid promote input.')
    const r = raw as Partial<MemoryPromoteInput>
    const scope = asMemoryScope(r.scope)
    const index = asMemoryIndex(r.index)
    const target = r.target
    if (target !== 'rule' && target !== 'skill') throw new Error('Invalid promote target.')
    if (typeof r.name !== 'string' || !COMMAND_NAME_PATTERN.test(r.name)) {
      throw new Error('Promotion name must be kebab-case.')
    }
    if (target === 'skill' && (typeof r.description !== 'string' || r.description.trim() === '')) {
      throw new Error('A description is required to promote to a skill.')
    }
    return {
      scope,
      index,
      target: target as PromoteTarget,
      name: r.name,
      ...(typeof r.description === 'string' ? { description: r.description } : {})
    }
  }

  ipcMain.handle('bearcode:skills:list', (_e, projectPath: unknown): SkillEntry[] =>
    listSkillEntries(asProjectPath(projectPath))
  )
  ipcMain.handle('bearcode:skills:create', (_e, input: unknown, projectPath: unknown): SkillEntry =>
    createSkill(assertValidSkillInput(input), asProjectPath(projectPath))
  )
  ipcMain.handle(
    'bearcode:skills:update',
    (_e, originalName: unknown, input: unknown, projectPath: unknown): SkillEntry => {
      if (typeof originalName !== 'string' || originalName.length === 0) {
        throw new Error('Invalid skill name.')
      }
      return updateSkill(originalName, assertValidSkillInput(input), asProjectPath(projectPath))
    }
  )
  ipcMain.handle(
    'bearcode:skills:delete',
    (_e, name: unknown, source: unknown, projectPath: unknown) => {
      if (typeof name !== 'string' || name.length === 0) throw new Error('Invalid skill name.')
      if (source !== 'global' && source !== 'project') throw new Error('Invalid skill source.')
      deleteSkillFolder(name, source, asProjectPath(projectPath))
    }
  )
  ipcMain.handle(
    'bearcode:skills:set-enabled',
    (_e, name: unknown, source: unknown, projectPath: unknown, enabled: unknown) => {
      if (typeof name !== 'string' || name.length === 0) throw new Error('Invalid skill name.')
      if (source !== 'global' && source !== 'project') throw new Error('Invalid skill source.')
      if (typeof enabled !== 'boolean') throw new Error('Invalid enabled flag.')
      setSkillEnabled(name, source, asProjectPath(projectPath), enabled)
    }
  )
  ipcMain.handle(
    'bearcode:skills:save',
    (_e, callId: unknown, resolution: unknown): SkillSaveResult => {
      if (typeof callId !== 'string' || callId.length === 0) throw new Error('Invalid callId.')
      return resolveSkillProposalOrchestrator(callId, assertValidSkillResolution(resolution))
    }
  )

  ipcMain.handle('bearcode:memory:list', (_e, projectPath: unknown): MemoryList =>
    listMemory(asProjectPath(projectPath))
  )
  ipcMain.handle(
    'bearcode:memory:add',
    (_e, scope: unknown, text: unknown, projectPath: unknown): 'ok' | 'full' => {
      if (typeof text !== 'string') throw new Error('Memory text must be a string.')
      return addMemory(asMemoryScope(scope), text, asProjectPath(projectPath))
    }
  )
  ipcMain.handle(
    'bearcode:memory:update',
    (_e, scope: unknown, index: unknown, text: unknown, projectPath: unknown): void => {
      if (typeof text !== 'string') throw new Error('Memory text must be a string.')
      updateMemory(asMemoryScope(scope), asMemoryIndex(index), text, asProjectPath(projectPath))
    }
  )
  ipcMain.handle(
    'bearcode:memory:delete',
    (_e, scope: unknown, index: unknown, projectPath: unknown): void => {
      deleteMemory(asMemoryScope(scope), asMemoryIndex(index), asProjectPath(projectPath))
    }
  )
  ipcMain.handle('bearcode:memory:promote', (_e, input: unknown, projectPath: unknown): void => {
    promoteMemory(assertValidPromoteInput(input), asProjectPath(projectPath))
  })

  // Plugins (Phase G plugins arc, Task 9): discovery/enable-state/uninstall
  // (./plugins, ./plugins/state) plus the marketplace browse/install surface
  // (./plugins/marketplace). Mirrors the mcp:* idiom above: validate the wire
  // input, then call straight through -- every write below is already
  // path-jailed and kebab-name validated inside the modules it calls into.
  // Project-scope listing/enable/uninstall is trust-gated the SAME way
  // commands:list/mentions:rules/mentions:skills already gate project content:
  // `db.isProjectTrusted(projectPath)`.
  ipcMain.handle('bearcode:plugins:list', (_e, projectPath: unknown): PluginEntry[] => {
    const proj = asProjectPath(projectPath)
    return listPlugins(proj, { trusted: proj != null && db.isProjectTrusted(proj) })
  })
  ipcMain.handle('bearcode:plugins:catalog', (): Promise<MarketplacePlugin[]> =>
    pluginMarket.listCatalog()
  )
  ipcMain.handle('bearcode:plugins:list-marketplaces', (): string[] =>
    pluginMarket.listMarketplaces()
  )
  ipcMain.handle('bearcode:plugins:add-marketplace', (_e, url: unknown): Promise<void> => {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error(`Invalid marketplace url: ${String(url)}`)
    }
    return pluginMarket.addMarketplace(url)
  })
  ipcMain.handle('bearcode:plugins:remove-marketplace', (_e, url: unknown): Promise<void> => {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error(`Invalid marketplace url: ${String(url)}`)
    }
    return pluginMarket.removeMarketplace(url)
  })
  ipcMain.handle(
    'bearcode:plugins:prepare-install',
    (
      _e,
      source: unknown,
      marketplaceUrl: unknown
    ): Promise<{ manifest: PluginManifest; stagePath: string }> => {
      if (typeof source !== 'string' || source.trim().length === 0) {
        throw new Error(`Invalid plugin install source: ${String(source)}`)
      }
      return pluginMarket.prepareInstall(
        source,
        typeof marketplaceUrl === 'string' ? marketplaceUrl : undefined
      )
    }
  )
  ipcMain.handle('bearcode:plugins:confirm-install', (_e, stagePath: unknown): void => {
    if (typeof stagePath !== 'string' || stagePath.trim().length === 0) {
      throw new Error(`Invalid stage path: ${String(stagePath)}`)
    }
    pluginMarket.confirmInstall(stagePath)
  })
  ipcMain.handle(
    'bearcode:plugins:install-from-url',
    (_e, url: unknown): Promise<{ manifest: PluginManifest; stagePath: string }> => {
      if (typeof url !== 'string' || url.trim().length === 0) {
        throw new Error(`Invalid plugin install url: ${String(url)}`)
      }
      return pluginMarket.installFromUrl(url)
    }
  )
  ipcMain.handle(
    'bearcode:plugins:set-enabled',
    (_e, scope: unknown, name: unknown, on: unknown, _projectPath: unknown): void => {
      if (typeof on !== 'boolean') throw new Error(`Invalid plugin enabled flag: ${String(on)}`)
      setPluginEnabled(validatePluginScope(scope), validatePluginName(name), on)
    }
  )
  ipcMain.handle('bearcode:plugins:update', (_e, name: unknown): Promise<void> => {
    return pluginMarket.updatePlugin(validatePluginName(name))
  })
  ipcMain.handle(
    'bearcode:plugins:uninstall',
    (_e, scope: unknown, name: unknown, projectPath: unknown): void => {
      uninstallPlugin(
        validatePluginScope(scope),
        validatePluginName(name),
        asProjectPath(projectPath)
      )
    }
  )

  // navigator.clipboard in the sandboxed renderer is blocked by our tight
  // permission handlers (media-only), so copy went through main's clipboard.
  ipcMain.handle('bearcode:clipboard:write', (_e, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
  })
  ipcMain.handle('bearcode:browser:hide', () => browserManager.hide())
}
