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
  MentionRef,
  ModelRef,
  PermissionMode,
  PermissionRulesInfo,
  PlanReviewResolveResult,
  Project,
  ProviderId,
  RunState
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
    list: () => ipcRenderer.invoke('bearcode:models:list')
  },
  commands: {
    list: (projectPath: string | null) => ipcRenderer.invoke('bearcode:commands:list', projectPath)
  },
  mentions: {
    files: (projectPath: string | null, query: string) =>
      ipcRenderer.invoke('bearcode:mentions:files', projectPath, query),
    rules: (projectPath: string | null) => ipcRenderer.invoke('bearcode:mentions:rules', projectPath)
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
    setProject: (id: string, projectId: string | null): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-project', id, projectId),
    setPinned: (id: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-pinned', id, pinned),
    setArchived: (id: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:set-archived', id, archived),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:conversations:rename', id, title)
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('bearcode:projects:list'),
    create: (name: string, color?: string | null): Promise<Project> =>
      ipcRenderer.invoke('bearcode:projects:create', name, color ?? null),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:projects:rename', id, name),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('bearcode:projects:delete', id)
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
