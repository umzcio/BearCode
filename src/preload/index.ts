import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddRuleInput,
  AppSettings,
  ArtifactComment,
  AttachmentRef,
  BearcodeApi,
  CommandRef,
  ConversationMeta,
  EffortLevel,
  Event,
  GithubDeviceStart,
  HookAuthoringInput,
  HookEvent,
  HookRecord,
  IntegrationProvider,
  IntegrationStatus,
  MentionRef,
  ModelRef,
  DiscoveredMcpServer,
  McpServerConfig,
  McpServerStatus,
  McpServerView,
  MarketplacePlugin,
  MemoryList,
  MemoryPromoteInput,
  MemoryScopeName,
  OutsideAccessInfo,
  OutsideFolderAccess,
  PermissionMode,
  PermissionRulesInfo,
  PlanReviewResolveResult,
  PluginEntry,
  PluginManifest,
  PluginUpdateResult,
  PreviewPayload,
  FolderProject,
  ProjectSettings,
  ProviderId,
  RuleEntry,
  RunState,
  SkillEntry,
  SkillInfo,
  SkillInput,
  SkillProposalResolution,
  SkillSaveResult,
  SmitheryHit,
  TranscribeMeta,
  UpdaterStatus
} from '../shared/types'

// The renderer talks to main only through this typed surface.
const bearcode: BearcodeApi = {
  ping: () => ipcRenderer.invoke('bearcode:ping'),
  run: {
    start: (
      conversationId: string,
      userText: string,
      modelRef: ModelRef,
      projectPath,
      command?: CommandRef | null,
      mentions?: MentionRef[] | null,
      attachments?: AttachmentRef[] | null
    ) =>
      ipcRenderer.invoke(
        'bearcode:run:start',
        conversationId,
        userText,
        modelRef,
        projectPath,
        command ?? null,
        mentions ?? null,
        attachments ?? null
      ),
    cancel: (conversationId: string) => ipcRenderer.invoke('bearcode:run:cancel', conversationId)
  },
  models: {
    list: () => ipcRenderer.invoke('bearcode:models:list'),
    manageable: () => ipcRenderer.invoke('bearcode:models:manageable')
  },
  history: {
    search: (query: string) => ipcRenderer.invoke('bearcode:history:search', query)
  },
  commands: {
    list: (projectPath: string | null) => ipcRenderer.invoke('bearcode:commands:list', projectPath)
  },
  mentions: {
    files: (projectPath: string | null, query: string) =>
      ipcRenderer.invoke('bearcode:mentions:files', projectPath, query),
    rules: (projectPath: string | null) =>
      ipcRenderer.invoke('bearcode:mentions:rules', projectPath),
    skills: (projectPath: string | null): Promise<SkillInfo[]> =>
      ipcRenderer.invoke('bearcode:mentions:skills', projectPath)
  },
  attachments: {
    pick: (conversationId: string, existingCount: number) =>
      ipcRenderer.invoke('bearcode:attachments:pick', conversationId, existingCount),
    read: (conversationId: string, id: string) =>
      ipcRenderer.invoke('bearcode:attachments:read', conversationId, id)
  },
  diffs: {
    get: (diffId: string) => ipcRenderer.invoke('bearcode:diffs:get', diffId),
    revert: (fileId: string) => ipcRenderer.invoke('bearcode:diffs:revert', fileId),
    open: (fileId: string) => ipcRenderer.invoke('bearcode:diffs:open', fileId),
    previewFile: (fileId: string): Promise<PreviewPayload> =>
      ipcRenderer.invoke('bearcode:diffs:preview', fileId)
  },
  shell: {
    openFile: (conversationId: string, path: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:shell:open-file', conversationId, path)
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
  ursa: {
    requiredProviders: () => ipcRenderer.invoke('bearcode:ursa:required-providers')
  },
  settings: {
    get: () => ipcRenderer.invoke('bearcode:settings:get'),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke('bearcode:settings:set', patch)
  },
  pricing: {
    sync: () => ipcRenderer.invoke('bearcode:pricing:sync')
  },
  conversations: {
    list: () => ipcRenderer.invoke('bearcode:conversations:list'),
    get: (id: string) => ipcRenderer.invoke('bearcode:conversations:get', id),
    create: (projectPath: string | null, id?: string) =>
      ipcRenderer.invoke('bearcode:conversations:create', projectPath, id),
    delete: (id: string) => ipcRenderer.invoke('bearcode:conversations:delete', id),
    clear: () => ipcRenderer.invoke('bearcode:conversations:clear'),
    setMode: (id: string, mode: PermissionMode): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-mode', id, mode),
    setEffort: (id: string, effort: EffortLevel): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-effort', id, effort),
    setThinking: (id: string, thinking: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-thinking', id, thinking),
    // F3: worktree provisioning happens main-side, so this passes only the
    // chosen environment and returns the updated meta.
    setEnvironment: (id: string, environment: 'local' | 'worktree'): Promise<ConversationMeta> =>
      ipcRenderer.invoke('bearcode:conversations:set-environment', id, environment),
    setPinned: (id: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-pinned', id, pinned),
    setArchived: (id: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-archived', id, archived),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:rename', id, title)
  },
  projects: {
    list: (): Promise<FolderProject[]> => ipcRenderer.invoke('bearcode:projects:list'),
    update: (path: string, patch: ProjectSettings): Promise<FolderProject> =>
      ipcRenderer.invoke('bearcode:projects:update', path, patch)
  },
  project: {
    isTrusted: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('bearcode:project:is-trusted', path),
    trust: (path: string): Promise<FolderProject> =>
      ipcRenderer.invoke('bearcode:project:trust', path),
    untrust: (path: string): Promise<FolderProject> =>
      ipcRenderer.invoke('bearcode:project:untrust', path),
    hasConfig: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('bearcode:project:has-config', path),
    outsideAccess: {
      get: (path: string): Promise<OutsideAccessInfo> =>
        ipcRenderer.invoke('bearcode:project:outside-access:get', path),
      set: (path: string, policy: OutsideFolderAccess): Promise<OutsideAccessInfo> =>
        ipcRenderer.invoke('bearcode:project:outside-access:set', path, policy),
      allow: (path: string, abs: string): Promise<OutsideAccessInfo> =>
        ipcRenderer.invoke('bearcode:project:outside-access:allow', path, abs),
      deny: (path: string, abs: string): Promise<OutsideAccessInfo> =>
        ipcRenderer.invoke('bearcode:project:outside-access:deny', path, abs),
      list: (path: string): Promise<OutsideAccessInfo> =>
        ipcRenderer.invoke('bearcode:project:outside-access:list', path),
      remove: (path: string, abs: string): Promise<OutsideAccessInfo> =>
        ipcRenderer.invoke('bearcode:project:outside-access:remove', path, abs)
    }
  },
  permissions: {
    addRule: (rule: AddRuleInput): Promise<void> =>
      ipcRenderer.invoke('bearcode:permissions:add-rule', rule),
    list: (): Promise<PermissionRulesInfo> => ipcRenderer.invoke('bearcode:permissions:list'),
    deleteRule: (id: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:permissions:delete-rule', id),
    setBuiltinDisabled: (id: string, disabled: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:permissions:set-builtin-disabled', id, disabled)
  },
  artifacts: {
    resolvePlanReview: (
      callId: string,
      proceed: boolean,
      message?: string
    ): Promise<PlanReviewResolveResult> =>
      ipcRenderer.invoke('bearcode:artifacts:resolve-plan-review', callId, proceed, message),
    addComment: (
      artifactId: string,
      quote: string | null,
      body: string
    ): Promise<ArtifactComment> =>
      ipcRenderer.invoke('bearcode:artifacts:add-comment', artifactId, quote, body),
    listComments: (artifactId: string): Promise<ArtifactComment[]> =>
      ipcRenderer.invoke('bearcode:artifacts:list-comments', artifactId)
  },
  voice: {
    transcribe: (audio: ArrayBuffer, meta: TranscribeMeta) =>
      ipcRenderer.invoke('bearcode:voice:transcribe', audio, meta)
  },
  workspace: {
    pick: () => ipcRenderer.invoke('bearcode:workspace:pick')
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('bearcode:clipboard:write', text)
  },
  worktree: {
    merge: (
      convId: string,
      repoPath: string
    ): Promise<{ status: 'clean' | 'conflict'; conflictedFiles: string[] }> =>
      ipcRenderer.invoke('bearcode:worktree:merge', convId, repoPath),
    readConflict: (convId: string, repoPath: string, file: string): Promise<{ merged: string }> =>
      ipcRenderer.invoke('bearcode:worktree:read-conflict', convId, repoPath, file),
    resolveFile: (convId: string, repoPath: string, file: string, content: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:worktree:resolve-file', convId, repoPath, file, content),
    completeMerge: (convId: string, repoPath: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:worktree:complete-merge', convId, repoPath),
    abort: (convId: string, repoPath: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:worktree:abort', convId, repoPath),
    discard: (convId: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:worktree:discard', convId),
    available: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('bearcode:worktree:available', path)
  },
  browser: {
    status: (): Promise<{
      installed: boolean
      connected: boolean
      conversationId: string | null
      debuggingEnabled: boolean
    }> => ipcRenderer.invoke('bearcode:browser:status'),
    clearSession: (): Promise<void> => ipcRenderer.invoke('bearcode:browser:clear-session'),
    setBounds: (b: { x: number; y: number; width: number; height: number }): Promise<void> =>
      ipcRenderer.invoke('bearcode:browser:set-bounds', b),
    show: (): Promise<void> => ipcRenderer.invoke('bearcode:browser:show'),
    hide: (): Promise<void> => ipcRenderer.invoke('bearcode:browser:hide')
  },
  mcp: {
    list: (projectPath: string | null): Promise<McpServerView[]> =>
      ipcRenderer.invoke('bearcode:mcp:list', projectPath),
    ensureConnected: (projectPath: string | null): Promise<McpServerView[]> =>
      ipcRenderer.invoke('bearcode:mcp:ensure-connected', projectPath),
    add: (cfg: McpServerConfig, projectPath: string | null): Promise<void> =>
      ipcRenderer.invoke('bearcode:mcp:add', cfg, projectPath),
    remove: (
      name: string,
      source: 'global' | 'project',
      projectPath: string | null
    ): Promise<void> => ipcRenderer.invoke('bearcode:mcp:remove', name, source, projectPath),
    setEnabled: (name: string, on: boolean, projectPath: string | null): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:set-enabled', name, on, projectPath),
    setEnabledConfigOnly: (name: string, on: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:mcp:set-enabled-config-only', name, on),
    trust: (name: string, projectPath: string): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:trust', name, projectPath),
    trustGlobal: (name: string): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:trust-global', name),
    trustPlugin: (plugin: string, name: string): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:trust-plugin', plugin, name),
    untrustPlugin: (plugin: string, name: string): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:untrust-plugin', plugin, name),
    spawnConsent: (name: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:mcp:spawn-consent', name),
    reconnect: (name: string, projectPath: string | null): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:reconnect', name, projectPath),
    authorize: (name: string, projectPath: string | null): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:authorize', name, projectPath),
    status: (name: string): Promise<McpServerStatus> =>
      ipcRenderer.invoke('bearcode:mcp:status', name),
    setSecret: (vaultKey: string, value: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:mcp:set-secret', vaultKey, value),
    smitherySearch: (query: string): Promise<SmitheryHit[]> =>
      ipcRenderer.invoke('bearcode:mcp:smithery-search', query),
    smitheryInstall: (id: string, projectPath: string | null): Promise<McpServerView> =>
      ipcRenderer.invoke('bearcode:mcp:smithery-install', id, projectPath),
    discover: (projectPath: string | null): Promise<DiscoveredMcpServer[]> =>
      ipcRenderer.invoke('bearcode:mcp:discover', projectPath),
    import: (
      servers: DiscoveredMcpServer[],
      projectPath: string | null
    ): Promise<McpServerView[]> => ipcRenderer.invoke('bearcode:mcp:import', servers, projectPath)
  },
  integrations: {
    status: (): Promise<IntegrationStatus[]> => ipcRenderer.invoke('bearcode:integrations:status'),
    githubDeviceStart: (): Promise<GithubDeviceStart> =>
      ipcRenderer.invoke('bearcode:integrations:github-device-start'),
    githubDevicePoll: (deviceCode: string, interval: number): Promise<IntegrationStatus> =>
      ipcRenderer.invoke('bearcode:integrations:github-device-poll', deviceCode, interval),
    cancelGithubDevice: (deviceCode: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:integrations:cancel-github-device', deviceCode),
    githubConnectPat: (token: string): Promise<IntegrationStatus> =>
      ipcRenderer.invoke('bearcode:integrations:github-connect-pat', token),
    connectBitbucket: (username: string, appPassword: string): Promise<IntegrationStatus> =>
      ipcRenderer.invoke('bearcode:integrations:connect-bitbucket', username, appPassword),
    disconnect: (provider: IntegrationProvider): Promise<void> =>
      ipcRenderer.invoke('bearcode:integrations:disconnect', provider)
  },
  skills: {
    list: (projectPath: string | null): Promise<SkillEntry[]> =>
      ipcRenderer.invoke('bearcode:skills:list', projectPath),
    create: (input: SkillInput, projectPath: string | null): Promise<SkillEntry> =>
      ipcRenderer.invoke('bearcode:skills:create', input, projectPath),
    update: (
      originalName: string,
      input: SkillInput,
      projectPath: string | null
    ): Promise<SkillEntry> =>
      ipcRenderer.invoke('bearcode:skills:update', originalName, input, projectPath),
    delete: (
      name: string,
      source: 'project' | 'global',
      projectPath: string | null
    ): Promise<void> => ipcRenderer.invoke('bearcode:skills:delete', name, source, projectPath),
    setEnabled: (
      name: string,
      source: 'project' | 'global',
      projectPath: string | null,
      enabled: boolean
    ): Promise<void> =>
      ipcRenderer.invoke('bearcode:skills:set-enabled', name, source, projectPath, enabled),
    save: (callId: string, resolution: SkillProposalResolution): Promise<SkillSaveResult> =>
      ipcRenderer.invoke('bearcode:skills:save', callId, resolution)
  },
  rules: {
    list: (projectPath: string | null): Promise<RuleEntry[]> =>
      ipcRenderer.invoke('bearcode:rules:list', projectPath)
  },
  memory: {
    list: (projectPath: string | null): Promise<MemoryList> =>
      ipcRenderer.invoke('bearcode:memory:list', projectPath),
    add: (
      scope: MemoryScopeName,
      text: string,
      projectPath: string | null
    ): Promise<'ok' | 'full'> =>
      ipcRenderer.invoke('bearcode:memory:add', scope, text, projectPath),
    update: (
      scope: MemoryScopeName,
      index: number,
      text: string,
      projectPath: string | null
    ): Promise<void> =>
      ipcRenderer.invoke('bearcode:memory:update', scope, index, text, projectPath),
    delete: (scope: MemoryScopeName, index: number, projectPath: string | null): Promise<void> =>
      ipcRenderer.invoke('bearcode:memory:delete', scope, index, projectPath),
    promote: (input: MemoryPromoteInput, projectPath: string | null): Promise<void> =>
      ipcRenderer.invoke('bearcode:memory:promote', input, projectPath)
  },
  plugins: {
    list: (projectPath: string | null): Promise<PluginEntry[]> =>
      ipcRenderer.invoke('bearcode:plugins:list', projectPath),
    catalog: (): Promise<MarketplacePlugin[]> => ipcRenderer.invoke('bearcode:plugins:catalog'),
    listMarketplaces: (): Promise<string[]> =>
      ipcRenderer.invoke('bearcode:plugins:list-marketplaces'),
    addMarketplace: (url: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:plugins:add-marketplace', url),
    removeMarketplace: (url: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:plugins:remove-marketplace', url),
    prepareInstall: (
      source: string,
      marketplaceUrl?: string
    ): Promise<{ manifest: PluginManifest; stagePath: string }> =>
      ipcRenderer.invoke('bearcode:plugins:prepare-install', source, marketplaceUrl),
    confirmInstall: (stagePath: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:plugins:confirm-install', stagePath),
    installFromUrl: (url: string): Promise<{ manifest: PluginManifest; stagePath: string }> =>
      ipcRenderer.invoke('bearcode:plugins:install-from-url', url),
    setEnabled: (
      scope: 'global' | 'project',
      name: string,
      on: boolean,
      projectPath: string | null
    ): Promise<void> =>
      ipcRenderer.invoke('bearcode:plugins:set-enabled', scope, name, on, projectPath),
    update: (name: string): Promise<PluginUpdateResult> =>
      ipcRenderer.invoke('bearcode:plugins:update', name),
    uninstall: (
      scope: 'global' | 'project',
      name: string,
      projectPath: string | null
    ): Promise<void> => ipcRenderer.invoke('bearcode:plugins:uninstall', scope, name, projectPath)
  },
  hooks: {
    list: (projectPath: string | null): Promise<HookRecord[]> =>
      ipcRenderer.invoke('bearcode:hooks:list', projectPath),
    setActive: (
      scope: 'global' | 'project' | 'plugin',
      source: string,
      name: string,
      on: boolean,
      projectPath: string | null
    ): Promise<void> =>
      ipcRenderer.invoke('bearcode:hooks:setActive', scope, source, name, on, projectPath),
    create: (input: HookAuthoringInput): Promise<void> =>
      ipcRenderer.invoke('bearcode:hooks:create', input),
    update: (
      name: string,
      original: { event: HookEvent; matcher: string; command: string },
      input: HookAuthoringInput
    ): Promise<void> => ipcRenderer.invoke('bearcode:hooks:update', name, original, input),
    delete: (name: string): Promise<void> => ipcRenderer.invoke('bearcode:hooks:delete', name)
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('bearcode:app:getVersion')
  },
  updater: {
    checkNow: (): Promise<UpdaterStatus> => ipcRenderer.invoke('bearcode:updater:checkNow'),
    installNow: (): Promise<void> => ipcRenderer.invoke('bearcode:updater:installNow')
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
  },
  onUpdaterStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdaterStatus): void => cb(status)
    ipcRenderer.on('bearcode:updater:status', listener)
    return () => ipcRenderer.removeListener('bearcode:updater:status', listener)
  }
}

contextBridge.exposeInMainWorld('bearcode', bearcode)
