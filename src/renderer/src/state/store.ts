import { create } from 'zustand'
import type {
  AddRuleInput,
  AppSettings,
  ApprovalDecision,
  ArtifactComment,
  AttachmentRef,
  CommandEntry,
  CommandRef,
  ConversationMeta,
  CustomModel,
  EffortLevel,
  Event,
  HermesConnectionMode,
  ImportCandidate,
  ImportSelection,
  ImportSummary,
  ManageableProvider,
  ManualRuleInfo,
  MentionRef,
  ModelRef,
  OutsideAccessInfo,
  PermissionMode,
  PermissionRulesInfo,
  PickedAttachmentWire,
  FolderProject,
  ProjectSettings,
  ProviderId,
  ProviderModels,
  ReviewLens,
  RunState,
  SettingsInfo,
  SkillInfo,
  SkillProposalResolution,
  UpdaterStatus,
  UrsaMode,
  WorktreeInfo
} from '@shared/types'
import { HERMES_MODEL_REF, URSA_MODEL_REF, URSUS_MODEL_REF } from '@shared/types'
import { applyAppearance, watchSystemTheme } from '../lib/appearance'
import { initWindowFocusTracking } from '../lib/windowFocus'
import { describeError } from '../lib/errors'
import { mergeEvent } from '../lib/mergeEvent'
import { resolveProjectDefaults } from '@shared/projectDefaults'
import { hasComposerDraftContent, type ComposerDraft } from '../lib/composerDraft'

export type ConvoRunState = RunState | 'idle'

export interface Convo {
  id: string
  projectPath: string | null
  projectLabel: string
  title: string
  modelRef: ModelRef | null
  permissionMode: PermissionMode
  effort: EffortLevel
  thinking: boolean
  webSearch: boolean
  ursaMode: UrsaMode
  hermesMode: HermesConnectionMode
  projectId: string | null
  pinned: boolean
  archived: boolean
  updatedAt: number
  createdAt: number
  loaded: boolean
  events: Event[]
  runState: ConvoRunState
  // F3: execution environment, chosen at creation and locked at first run.
  // 'local' runs in the project folder; 'worktree' runs in isolated git
  // worktrees. Mirrors ConversationMeta.environment; defaults to 'local'.
  environment: 'local' | 'worktree'
  // F3: the spawned worktrees (one per discovered repo) for this conversation.
  // Empty in local mode, or when the project had no git repo so worktree mode
  // fell back to local. Mirrors ConversationMeta.worktrees; drives the
  // per-conversation Worktree action bar (Merge/Discard).
  worktrees: WorktreeInfo[]
  startedAt?: number
  // First-user-message snippet from the DB (F1 History browse), so a preview
  // shows even before the conversation's events are loaded this session. null
  // until known.
  preview?: string | null
}

type View =
  | { kind: 'home' }
  | { kind: 'conversation'; id: string }
  | { kind: 'history' }
  | { kind: 'terminal'; path: string }
  | { kind: 'project'; path: string | null }
  | { kind: 'projects' }
  | { kind: 'models' }

export type TerminalTabMeta = {
  id: string
  title: string
  exited: boolean
}

export interface ReviewComment {
  id: string
  path: string
  line: number
  text: string
}

// The Artifacts pane's target (Ba4 unification). ONE field for the ONE side
// panel: an artifact (plan/walkthrough viewer) or a diff group (the virtual
// "Changes" entry over the existing diffs table, design 3.4). Mutual
// exclusion is structural -- the old reviewDiffId/reviewArtifactId pair kept
// it by hand across three actions.
export type AuxSelection =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'diff'; diffId: string }
  // F4: the embedded browser pane. Self-contained (no DB lookup) -- the
  // WebContentsView is a main-side singleton keyed by conversation; the aux
  // pane just carries which conversation opened it so the placeholder rect
  // reports its bounds for the view to paint over.
  | { kind: 'browser'; conversationId: string }
  // Review mode: an arbitrary workspace file opened at a finding's exact line.
  // Unlike 'diff'/'artifact' this target isn't in the deliverable rail -- the
  // pane fetches the file's text (jailed IPC) and reveals `line` in Monaco.
  | { kind: 'file'; path: string; line?: number }
  | {
      kind: 'attachment'
      conversationId: string
      attachmentId: string
    }

// Auto-surface the newest diff group. Returns true when a fresh file_diff
// arrives for the conversation you're viewing AND the review pane is already
// open on a *different* diff -- then the pane should follow it to the new
// change-set rather than leaving you stranded on an older/rejected one
// (design 2026-07-06). Guarded so it NEVER opens a closed pane and NEVER yanks
// you off a plan/walkthrough you're reading; only genuinely new events (not
// re-emits of one already in history) trigger the follow.
export function shouldFollowNewDiff(
  s: {
    view: { kind: string; id?: string }
    auxSelection: AuxSelection | null
    conversations: Record<string, { events: { id: string }[] } | undefined>
  },
  convoId: string,
  event: Event
): boolean {
  return (
    event.type === 'file_diff' &&
    s.view.kind === 'conversation' &&
    s.view.id === convoId &&
    s.auxSelection?.kind === 'diff' &&
    s.auxSelection.diffId !== event.diffId &&
    !(s.conversations[convoId]?.events.some((e) => e.id === event.id) ?? false)
  )
}

// F4: auto-open the embedded browser pane the moment the agent first uses the
// browser in a turn. An offscreen/0-size WebContentsView is never composited
// (screenshots come back blank and the user sees nothing), so the pane MUST
// mount on-screen once -- its ResizeObserver then pushes real bounds to
// BrowserManager.
//
// Fires ONLY on the FIRST browser_* tool_call of a turn for the conversation
// you're viewing, tracked by the `openedConvos` latch (a conversation is added
// to it when the pane auto-opens and cleared when the user sends a new
// message). After that first open it NEVER re-opens on subsequent browser steps
// -- so if the user moves the pane to a diff/artifact to read while the agent
// keeps browsing (or an approval re-emits a pending tool_call), the pane is not
// yanked back (Fable B3 finding 2). This mirrors shouldFollowNewDiff's ethos of
// never yanking you off what you're reading. A fresh user turn resets the latch
// so a newly-requested browser task can re-open a pane the user had closed.
export function shouldOpenBrowserPane(
  s: {
    view: { kind: string; id?: string }
    auxSelection: AuxSelection | null
  },
  convoId: string,
  event: Event,
  openedConvos: ReadonlySet<string> = new Set()
): boolean {
  return (
    event.type === 'tool_call' &&
    event.tool.startsWith('browser_') &&
    s.view.kind === 'conversation' &&
    s.view.id === convoId &&
    !openedConvos.has(convoId) &&
    !(s.auxSelection?.kind === 'browser' && s.auxSelection.conversationId === convoId)
  )
}

// Resizable pane bounds (px). Drag handles clamp to these; persisted widths
// are re-clamped on read so a stored out-of-range value can't wedge a pane.
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 520
export const AUX_MIN = 380
export const AUX_MAX = 980

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  } catch {
    return fallback
  }
}
function writeStoredWidth(key: string, w: number): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(w))
  } catch {
    // No localStorage (e.g. test env) -- width just isn't persisted this session.
  }
}

// "Worked for Ns" per agent turn, keyed by the turn's user_message event id.
// The working phase ends when prose starts streaming.
export const workedSecondsByTurn = new Map<string, number>()
const turnStartByConvo = new Map<string, { turnId: string; startedAt: number; frozen: boolean }>()

// F4 (Fable B3 finding 2): conversations whose browser pane has already
// auto-opened this turn. shouldOpenBrowserPane consults it so the pane opens
// exactly once per turn and never yanks the user off a diff/artifact on later
// browser steps. Cleared when a new user_message turn begins for the convo.
const browserPaneAutoOpened = new Set<string>()

// Prune all per-conversation tracking entries so a deleted conversation leaves
// no permanent residue (turnStartByConvo/browserPaneAutoOpened keyed by convoId;
// workedSecondsByTurn keyed by the turn's user_message id — only ever set for
// turns run this session, whose events are in memory). (audit L-1 / L-19)
export function pruneConvoTracking(id: string, events: readonly Event[]): void {
  turnStartByConvo.delete(id)
  browserPaneAutoOpened.delete(id)
  for (const ev of events) {
    if (ev.type === 'user_message') workedSecondsByTurn.delete(ev.id)
  }
}

function basename(p: string): string {
  const parts = p.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || p
}

function fromMeta(meta: ConversationMeta): Convo {
  return {
    id: meta.id,
    projectPath: meta.projectPath,
    projectLabel: meta.projectPath ? basename(meta.projectPath) : 'No folder',
    title: meta.title ?? 'New conversation',
    modelRef: meta.modelRef,
    permissionMode: meta.permissionMode,
    effort: meta.effort,
    thinking: meta.thinking,
    webSearch: meta.webSearch,
    ursaMode: meta.ursaMode,
    hermesMode: meta.hermesMode,
    projectId: meta.projectId,
    pinned: meta.pinned,
    archived: meta.archived,
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    loaded: false,
    events: [],
    runState: 'idle',
    environment: meta.environment,
    worktrees: meta.worktrees ?? [],
    preview: meta.preview ?? null
  }
}

function orderByRecency(conversations: Record<string, Convo>): string[] {
  return Object.values(conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => c.id)
}

interface AppState {
  sidebarCollapsed: boolean
  sidebarWidth: number
  auxPaneWidth: number
  // Incremented by the Cmd+/ shortcut; the mounted ModelPicker toggles on change.
  modelMenuTick: number
  // Incremented by the Cmd+; shortcut; the Home project menu toggles on change.
  projectMenuTick: number
  // Incremented to toggle the mounted ModePicker menu.
  permMenuTick: number
  view: View
  conversations: Record<string, Convo>
  convoOrder: string[]
  providers: ProviderModels[]
  // F7 Models page management list (curated + custom incl. disabled). Loaded on
  // demand by the Models settings page; empty until then.
  manageableModels: ManageableProvider[]
  modelRef: ModelRef | null
  permissionMode: PermissionMode
  effort: EffortLevel
  thinking: boolean
  // Per-conversation server-side Web Search toggle (effort-popover row);
  // mirrors `thinking`'s composer-state idiom. Default OFF (searches bill).
  webSearch: boolean
  // Ursa-only composer state: the per-conversation Mode that replaces the
  // (meaningless-for-a-router) effort control when the model is Ursa. Mirrors
  // `effort`'s persistence idiom; coerces to 'auto' with no settings default.
  ursaMode: UrsaMode
  // F9 (folder = project): per-folder settings rows (only folders that carry a
  // stored row appear; folders with none resolve to all-null). Looked up by path
  // for a group's color/icon/name and a new conversation's inherited defaults.
  folderSettings: FolderProject[]
  // The folder path whose Project Settings modal is open, or null. Mirrors the
  // settingsOpen modal-flag idiom.
  projectSettingsPath: string | null
  settings: SettingsInfo | null
  // Permissions manager read model; null until the Settings section first loads it.
  permissionRules: PermissionRulesInfo | null
  workspacePath: string | null
  // Project Trust: whether the current workspace has been explicitly trusted.
  workspaceTrusted: boolean
  workspaceHasAgentsConfig: boolean
  workspaceImportCandidates: ImportCandidate[]
  workspaceImportBannerVisible: boolean
  importReviewOpen: boolean
  outsideAccess: OutsideAccessInfo | null
  trustBannerDismissed: boolean
  // Signed macOS builds arc: current app version + live electron-updater status.
  appVersion: string | null
  updaterStatus: UpdaterStatus
  updateBannerDismissed: boolean
  settingsOpen: boolean
  // Which settings page to open on (e.g. 'providers' for the missing-key flow);
  // null → default page. Consumed once by SettingsModal on open.
  settingsInitialPage: string | null
  auxSelection: AuxSelection | null
  terminalTabs: Record<string, TerminalTabMeta[]>
  activeTerminalTab: Record<string, string | undefined>
  // File path the diff viewer should focus when it opens (chip/step clicks).
  reviewFocusPath: string | null
  // Drafted/sent comments per artifact id, loaded lazily by the pane.
  artifactComments: Record<string, ArtifactComment[]>
  // Session-only review drafts, keyed by diff id. These intentionally do not
  // participate in persistence or IPC.
  diffReviewComments: Record<string, ReviewComment[]>
  // Session-level pending flags so rail navigation/remounts cannot duplicate a
  // review send for the same diff.
  diffReviewSending: Record<string, boolean>
  // Tick: the pane focuses its feedback box when this increments (the pending
  // card's "Send feedback" action).
  artifactPaneFocusFeedback: number
  // Tick: incremented on EVERY deep-link open (openReview, openReviewForFile,
  // openArtifactPane) so the pane re-selects its target even when the VALUE
  // is unchanged -- the unified pane does not remount per selection (rail
  // browsing is pane-local state), so an already-open pane needs an explicit
  // signal to override local browsing.
  auxPaneOpenTick: number
  toast: { message: string; action?: { label: string; run: () => void } } | null
  // The slash menu's read model (D2 design 6.1), re-fetched on menu open.
  commands: CommandEntry[]
  // /resume is a pure UI action (D2 design 6.2): it opens this picker rather
  // than starting a turn.
  resumePickerOpen: boolean
  // D3 @ menu read models, fetched on menu interaction (mirrors commands).
  fileSuggestions: string[]
  manualRules: ManualRuleInfo[]
  // Enabled MCP servers for the @connector category (Phase G).
  mcpConnectors: { name: string; toolCount: number }[]
  // The @skill category's read model (mirrors manualRules).
  manualSkills: SkillInfo[]
  // D4 Media on Home: a new conversation has no id until startFromHome's first
  // send (conversations.create happens then), but Media needs a conversation
  // id to key the attachments directory at PICK time. This is a client-minted
  // placeholder id (crypto.randomUUID()) lazily set by ensureDraftConvoId the
  // first time Home's Media is used, then handed to conversations.create as
  // the id to create so already-picked attachments line up with the real
  // conversation. Cleared on goHome / after Composer completes an accepted Home start.
  draftConvoId: string | null
  // Owns the entire async Home start, from synchronous ID reservation through
  // accepted Composer handoff completion. While set, Home navigation and
  // duplicate first-run dispatches are blocked.
  pendingHomeConvoId: string | null
  // Distinguishes successive ownership attempts that happen to reuse the same
  // conversation id. Async continuations must match both fields before they
  // publish state, so deletion can permanently retire an in-flight attempt.
  pendingHomeAttempt: number | null
  // A successfully accepted Home start remains owned by the Home composer until
  // it transfers any post-submit edits to the mounted conversation composer.
  acceptedHomeConvoId: string | null
  conversationDraftHandoff: { conversationId: string; draft: ComposerDraft } | null
  // F1 Conversation History: the event a content-search hit should jump to in
  // the freshly-opened conversation. Transient -- set by openConvo(id, {focusEventId})
  // and consumed by ConversationView, which scrolls to + highlights the match.
  // Stays set as the "current" match so the next/prev navigator can advance it;
  // ConversationView calls clearFocusEvent when the target isn't in the rendered
  // list (e.g. compacted away). Null when no jump is pending.
  focusEventId: string | null
  // The full set of event ids the active search matched in this conversation, in
  // display order. Drives the "N of M" jump navigator; stepFocus walks it. Empty
  // (or length 1) hides the navigator -- a lone hit needs no next/prev.
  focusMatches: string[]
  // Identity for the current view/focus owner. This changes even when a newer
  // search installs values identical to the previous search, allowing an older
  // accepted send to clear only the focus state it actually dispatched under.
  focusRevision: number
  // F3: the environment drafted in the Home composer's Local/New-Worktree
  // picker, applied to the conversation at create (before its first run) and
  // then locked. Reset to 'local' on goHome.
  composerEnvironment: 'local' | 'worktree'
  // F3: an in-progress merge that hit conflicts, driving the Monaco conflict
  // resolver (Task 12). Set by mergeWorktree when the per-repo merge returns
  // 'conflict'; the resolver walks `files` one at a time via `index`. null when
  // no merge is being resolved.
  conflict: { convId: string; repoPath: string; files: string[]; index: number } | null

  init(): void
  refreshProviders(): Promise<void>
  // F7 model management.
  refreshManageableModels(): Promise<void>
  setModelEnabled(ref: string, enabled: boolean): Promise<void>
  addCustomModel(model: CustomModel): Promise<void>
  removeCustomModel(provider: ProviderId, id: string): Promise<void>
  toggleSidebar(): void
  setSidebarCollapsed(collapsed: boolean): void
  setSidebarWidth(w: number, options?: { persist?: boolean }): void
  setAuxPaneWidth(w: number, options?: { persist?: boolean }): void
  toggleModelMenu(): void
  goHome(): void
  openHistory(): void
  openTerminalView(path: string): void
  openProjectPage(path: string | null): void
  openProjectsIndex(): void
  openModelsPage(): void
  createTerminalTab(path: string): Promise<void>
  closeTerminalTab(path: string, id: string): Promise<void>
  setActiveTerminalTab(path: string, id: string): void
  markTerminalTabExited(path: string, id: string): void
  openConvo(id: string, opts?: { focusEventId?: string; focusMatches?: string[] }): void
  clearFocusEvent(): void
  stepFocus(dir: -1 | 1): void
  // Replace the match set (F1). ConversationView reorders bm25-ranked matches
  // into transcript order once the events are loaded, so the next/prev
  // navigator steps monotonically down the conversation.
  setFocusMatches(ids: string[]): void
  startFromHome(
    text: string,
    command?: CommandRef | null,
    mentions?: MentionRef[] | null,
    attachments?: AttachmentRef[] | null
  ): Promise<boolean>
  completeHomeStart(remainingDraft: ComposerDraft): void
  consumeConversationDraftHandoff(conversationId: string): void
  deleteConvo(id: string): void
  send(
    convoId: string,
    text: string,
    command?: CommandRef | null,
    mentions?: MentionRef[] | null,
    attachments?: AttachmentRef[] | null
  ): Promise<boolean>
  cancelRun(convoId: string): void
  approveTool(callId: string, approved: boolean): void
  // Ursa Phase 2: approve/deny a proposed pipeline (the synthetic 'ursa_pipeline'
  // consent card). Fire-and-forget like approveTool; progress flows back over
  // bearcode:event. Approve runs the steps in order; deny runs the turn
  // single-role, exactly as Phase 1.
  resolvePipeline(convoId: string, callId: string, approved: boolean): void
  // Review mode (Phase H, Task 5): resolve a review_clarify card. Fire-and-
  // forget like resolvePipeline; the re-dispatched run's progress flows back
  // over bearcode:event.
  resolveReviewClarification(conversationId: string, lens: ReviewLens, scope: string): void
  resolveHermesApproval(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void>
  resolveHermesClarification(
    conversationId: string,
    requestId: string,
    response: string
  ): Promise<void>
  addPermissionRule(input: AddRuleInput): void
  refreshPermissionRules(): Promise<void>
  deletePermissionRule(id: string): Promise<void>
  setBuiltinDisabled(id: string, disabled: boolean): Promise<void>
  retryRun(convoId: string): void
  selectModel(ref: ModelRef): void
  setSidebarView(patch: {
    sidebarGroupBy?: AppSettings['sidebarGroupBy']
    sidebarSort?: AppSettings['sidebarSort']
    sidebarShowArchived?: AppSettings['sidebarShowArchived']
    sidebarSubtitle?: AppSettings['sidebarSubtitle']
  }): Promise<void>
  setAppearance(patch: Partial<AppSettings>): Promise<void>
  syncPricing(): Promise<{
    syncedCount: number
    metadataCount: number
    unmatched: string[]
    syncedAt: number
  }>
  setPermissionMode(mode: PermissionMode): void
  setEffort(effort: EffortLevel): void
  setThinking(thinking: boolean): void
  setWebSearch(webSearch: boolean): void
  setUrsaMode(mode: UrsaMode): void
  setComposerEnvironment(v: 'local' | 'worktree'): void
  // F3: merge one repo's worktree branch into its base branch. On a clean merge
  // it toasts; on conflict it opens the resolver by setting `conflict`.
  mergeWorktree(convId: string, repoPath: string): Promise<void>
  // F3: tear down all of a conversation's worktrees and reset it to local.
  discardWorktree(convId: string): Promise<void>
  // F9 (folder = project) settings, keyed by workspace path.
  refreshProjectSettings(): Promise<void>
  updateProject(path: string, patch: ProjectSettings): Promise<void>
  // Sidebar redesign: toggles a project's `pinned` flag through the same
  // updateProject persistence path (bearcode:projects:update).
  toggleProjectPinned(path: string): Promise<void>
  setAsNewProjectDefault(patch: ProjectSettings): Promise<void>
  openProjectSettings(path: string): void
  closeProjectSettings(): void
  setPinned(id: string, pinned: boolean): void
  setArchived(id: string, archived: boolean): void
  renameConversation(id: string, title: string): void
  newConversationInProject(path: string): Promise<void>
  // Hermes: mints a project-less conversation pinned to HERMES_MODEL_REF and
  // opens it (Task 7 IPC does the DB work; this just reflects it into state).
  newHermesConversation(): Promise<void>
  testHermesConnection(
    mode: HermesConnectionMode,
    url: string,
    secret?: string
  ): Promise<{ ok: boolean; message: string }>
  saveHermesToken(token: string): Promise<void>
  saveHermesPlatformKey(key: string): Promise<void>
  togglePermMenu(): void
  pickWorkspace(): Promise<void>
  setWorkspace(path: string | null): void
  refreshTrustState(path: string | null): Promise<void>
  trustWorkspace(): Promise<void>
  dismissTrustBanner(): void
  refreshImportBannerState(path: string | null): Promise<void>
  dismissImportBanner(): Promise<void>
  openImportReview(): void
  closeImportReview(): void
  applyImportSelection(selection: ImportSelection): Promise<ImportSummary>
  checkForUpdates(): Promise<void>
  installUpdate(): void
  dismissUpdateBanner(): void
  allowOutside(abs: string): Promise<void>
  denyOutside(abs: string): Promise<void>
  removeOutside(path: string, abs: string): Promise<void>
  toggleProjectMenu(): void
  openSettings(page?: string): void
  closeSettings(): void
  saveKey(provider: ProviderId, key: string): Promise<void>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  deleteAllConversations(): Promise<void>
  openReview(diffId: string): void
  openReviewForFile(convoId: string, path: string): void
  openFile(path: string): void
  // Review mode: open a workspace file in the aux pane at an optional line.
  openFileInPane(path: string, line?: number): void
  openArtifactPane(artifactId: string, focusFeedback?: boolean): void
  openAttachmentPane(conversationId: string, attachmentId: string): void
  // F4: open the embedded browser pane for a conversation.
  openBrowserPane(conversationId: string): void
  loadArtifactComments(artifactId: string): Promise<void>
  addArtifactComment(artifactId: string, quote: string | null, body: string): Promise<void>
  addDiffReviewComment(diffId: string, comment: Omit<ReviewComment, 'id'>): void
  removeDiffReviewComment(diffId: string, commentId: string): void
  clearDiffReviewComments(diffId: string, commentIds?: readonly string[]): void
  beginDiffReviewSend(diffId: string): boolean
  finishDiffReviewSend(diffId: string): void
  resolvePlanReview(callId: string, proceed: boolean, message?: string): Promise<boolean>
  resolveSkillProposal(callId: string, resolution: SkillProposalResolution): Promise<void>
  closeReview(): void
  showToast(message: string, action?: { label: string; run: () => void }): void
  dismissToast(): void
  refreshCommands(): void
  setResumePickerOpen(open: boolean): void
  suggestFiles(query: string): void
  refreshManualRules(): void
  refreshMcpConnectors(): void
  refreshManualSkills(): void
  pickAttachments(
    existingCount: number
  ): Promise<{ picked: PickedAttachmentWire[]; errors: string[] }>
  ensureDraftConvoId(): string
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false
let nextReviewCommentId = 1
let nextHomeAttempt = 1

// "1 rule" / "3 rules" — used by the import-summary toast (final review
// Finding 3). Every noun it is applied to takes a plain -s plural.
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function modelDisplay(
  providers: ProviderModels[],
  ref: ModelRef | null
): { name: string; color: string } {
  // Orange, matching ursa-teddy.svg's dominant body colour (the composer aura
  // uses the same palette) -- was BearCode blue, which matched nothing.
  if (ref === URSA_MODEL_REF) return { name: 'Ursa', color: '#ed5500' }
  // Light blue, matching ursus-teddy.svg's palette (the original brown was set
  // for the retired walking-bear icon and no longer matched anything).
  if (ref === URSUS_MODEL_REF) return { name: 'Ursus', color: '#6ec3fa' }
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
  // The Ursa sentinel isn't a real "provider/modelId" ref -- ModelPicker
  // already gates its selectability on ursaEnabled + at least one usable
  // provider, so a conversation that has it selected is inherently ready.
  // Per-turn eligibility is re-checked server-side by resolveUrsaModelRef;
  // a failure there surfaces as its own error event, not this composer notice.
  // Same rationale for the Hermes sentinel: it routes to the Hermes Gateway,
  // not a provider/model pair, so it's always "configured" here -- the Hermes
  // settings page gates whether the Gateway itself is reachable/enabled.
  if (ref === URSA_MODEL_REF || ref === URSUS_MODEL_REF || ref === HERMES_MODEL_REF) return true
  const slash = ref.indexOf('/')
  const providerId = ref.slice(0, slash)
  const modelId = ref.slice(slash + 1)
  const provider = providers.find((p) => p.id === providerId)
  // The model must still be present in the provider's EFFECTIVE list: a model the
  // user opted out of (F7) — or a removed custom model — is no longer selectable,
  // so the active/default ref must fall through to another model, not keep
  // silently running a hidden one.
  return Boolean(
    provider &&
    provider.keyConfigured &&
    provider.reachable &&
    provider.models.some((m) => m.id === modelId)
  )
}

export const useAppStore = create<AppState>((set, get) => {
  function ownsHomeAttempt(conversationId: string, attempt: number): boolean {
    const state = get()
    return state.pendingHomeConvoId === conversationId && state.pendingHomeAttempt === attempt
  }

  // Resolves the "active project" for @-menu / commands lookups: the open
  // conversation's project, or the Home composer's picked workspace when
  // there is no conversation yet.
  function activeProjectPath(): string | null {
    const { view, conversations, workspacePath } = get()
    return view.kind === 'conversation'
      ? (conversations[view.id]?.projectPath ?? null)
      : workspacePath
  }

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
      const events = mergeEvent(convo.events, event)
      return { conversations: { ...s.conversations, [convoId]: { ...convo, events } } }
    })
  }

  function handleEvent(convoId: string, event: Event): void {
    // A turn's worked time runs from its user_message until the run reaches a
    // terminal state (done/error/cancelled), captured in onRunStateChange below.
    if (event.type === 'user_message') {
      turnStartByConvo.set(convoId, { turnId: event.id, startedAt: Date.now(), frozen: false })
      patchConvo(convoId, { startedAt: Date.now() })
      // F4: a new turn resets the browser auto-open latch, so a freshly
      // requested browser task can re-open a pane the user had closed.
      browserPaneAutoOpened.delete(convoId)
    }
    // Auto-surface the newest diff group (design 2026-07-06): see
    // shouldFollowNewDiff. Decided BEFORE upsert so "already seen" is accurate.
    const follow = shouldFollowNewDiff(get(), convoId, event)
    // F4: decided BEFORE upsert so the "not already showing" check reflects the
    // pane state as of this event's arrival. The latch (browserPaneAutoOpened)
    // makes it fire once per turn and never yank the pane off a diff/artifact.
    const openBrowser = shouldOpenBrowserPane(get(), convoId, event, browserPaneAutoOpened)
    upsertEvent(convoId, event)
    if (follow && event.type === 'file_diff') get().openReview(event.diffId)
    if (openBrowser) {
      browserPaneAutoOpened.add(convoId)
      get().openBrowserPane(convoId)
    }
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
    sidebarWidth: readStoredWidth('bearcode.sidebarWidth', 280, SIDEBAR_MIN, SIDEBAR_MAX),
    auxPaneWidth: readStoredWidth('bearcode.auxPaneWidth', 560, AUX_MIN, AUX_MAX),
    modelMenuTick: 0,
    projectMenuTick: 0,
    permMenuTick: 0,
    view: { kind: 'home' },
    conversations: {},
    convoOrder: [],
    providers: [],
    manageableModels: [],
    modelRef: null,
    permissionMode: 'accept-edits',
    effort: 'adaptive',
    thinking: true,
    webSearch: false,
    ursaMode: 'code',
    folderSettings: [],
    projectSettingsPath: null,
    settings: null,
    permissionRules: null,
    workspacePath: null,
    workspaceTrusted: false,
    workspaceHasAgentsConfig: false,
    workspaceImportCandidates: [],
    workspaceImportBannerVisible: false,
    importReviewOpen: false,
    outsideAccess: null,
    trustBannerDismissed: false,
    appVersion: null,
    updaterStatus: { state: 'idle' },
    updateBannerDismissed: false,
    settingsOpen: false,
    settingsInitialPage: null,
    auxSelection: null,
    terminalTabs: {},
    activeTerminalTab: {},
    reviewFocusPath: null,
    artifactComments: {},
    diffReviewComments: {},
    diffReviewSending: {},
    artifactPaneFocusFeedback: 0,
    auxPaneOpenTick: 0,
    toast: null,
    commands: [],
    resumePickerOpen: false,
    fileSuggestions: [],
    manualRules: [],
    mcpConnectors: [],
    manualSkills: [],
    draftConvoId: null,
    pendingHomeConvoId: null,
    pendingHomeAttempt: null,
    acceptedHomeConvoId: null,
    conversationDraftHandoff: null,
    focusEventId: null,
    focusMatches: [],
    focusRevision: 0,
    composerEnvironment: 'local',
    conflict: null,

    init: () => {
      if (initialized) return
      initialized = true
      window.bearcode.onEvent(handleEvent)
      window.bearcode.onRunStateChange((convoId, state) => {
        if (state === 'done' || state === 'error' || state === 'cancelled') {
          const turn = turnStartByConvo.get(convoId)
          if (turn && !turn.frozen) {
            turn.frozen = true
            workedSecondsByTurn.set(
              turn.turnId,
              Math.max(1, Math.round((Date.now() - turn.startedAt) / 1000))
            )
          }
        }
        patchConvo(convoId, { runState: state })
      })
      window.bearcode.onConversationMeta((meta) => {
        set((s) => {
          const existing = s.conversations[meta.id]
          if (!existing) return s
          const conversations = {
            ...s.conversations,
            [meta.id]: {
              ...existing,
              title: meta.title ?? existing.title,
              modelRef: meta.modelRef,
              updatedAt: meta.updatedAt
            }
          }
          return { conversations, convoOrder: orderByRecency(conversations) }
        })
      })
      window.bearcode.onUpdaterStatus((status) => {
        set({ updaterStatus: status })
      })
      void window.bearcode.app.getVersion().then((appVersion) => set({ appVersion }))
      void (async () => {
        const settings = await window.bearcode.settings.get()
        set({ settings })
        // Apply the persisted appearance immediately + follow OS theme changes
        // while in 'system' mode.
        applyAppearance(settings)
        initWindowFocusTracking()
        watchSystemTheme(() => {
          const s = get().settings
          return s ?? settings
        })
        // One-time seed: adopt the configured default only if the user hasn't
        // picked a mode yet. This runs exactly once per app session (init is
        // guarded by `initialized`), unlike ensureDefaultModel which fires on
        // every refreshProviders() call and would otherwise clobber a later
        // user selection of 'accept-edits'.
        if (settings.defaultPermissionMode && get().permissionMode === 'accept-edits') {
          set({ permissionMode: settings.defaultPermissionMode })
        }
        // One-time seed of the effort/thinking defaults, only if the user
        // hasn't diverged from the built-in defaults yet (mirrors the mode seed).
        if (get().effort === 'adaptive') set({ effort: settings.defaultEffort })
        if (get().thinking === true) set({ thinking: settings.defaultThinking })
        const metas = await window.bearcode.conversations.list()
        const conversations: Record<string, Convo> = {}
        for (const meta of metas) conversations[meta.id] = fromMeta(meta)
        set({ conversations, convoOrder: orderByRecency(conversations) })
        await get().refreshProjectSettings()
        await get().refreshProviders()
      })()
    },

    refreshProviders: async () => {
      const providers = await window.bearcode.models.list()
      set({ providers })
      ensureDefaultModel()
    },

    refreshManageableModels: async () => {
      set({ manageableModels: await window.bearcode.models.manageable() })
    },

    setModelEnabled: async (ref, enabled) => {
      const s = get().settings
      if (!s) return
      const [providerId, ...rest] = ref.split('/')
      const modelId = rest.join('/')
      const model = get()
        .manageableModels.find((p) => p.id === providerId)
        ?.models.find((m) => m.id === modelId)
      if (!model) return
      // liveOnly models (discovered, not curated) are opt-IN: absence from
      // enabledLiveModels means disabled. Everything else is opt-OUT via
      // disabledModels, unchanged from before liveOnly existed.
      // Disabling the persisted default model clears it, so a hidden model is
      // never re-selected for new conversations (ensureDefaultModel).
      const patch = model?.liveOnly
        ? (() => {
            const cur = s.enabledLiveModels ?? []
            const enabledLiveModels = enabled
              ? [...new Set([...cur, ref])]
              : cur.filter((r) => r !== ref)
            // Enabling a liveOnly model also proactively removes any stale
            // disabledModels entry for the same ref: if this ref was disabled
            // before liveOnly existed (or by any other path), that entry is
            // currently harmless while liveOnly stays true, but would silently
            // re-disable the model the moment it becomes a curated (non-live)
            // entry and liveOnly flips to false.
            const base = enabled
              ? {
                  enabledLiveModels,
                  disabledModels: (s.disabledModels ?? []).filter((r) => r !== ref)
                }
              : { enabledLiveModels }
            return !enabled && s.defaultModelRef === ref ? { ...base, defaultModelRef: null } : base
          })()
        : (() => {
            const cur = s.disabledModels ?? []
            const disabledModels = enabled
              ? cur.filter((r) => r !== ref)
              : [...new Set([...cur, ref])]
            return !enabled && s.defaultModelRef === ref
              ? { disabledModels, defaultModelRef: null }
              : { disabledModels }
          })()
      // Optimistic synchronous update: rapid consecutive toggles then read the
      // updated array (no lost-update race), and the switch flips immediately
      // rather than after the (Ollama-fetching) provider refresh completes.
      set((st) => ({
        settings: { ...s, ...patch },
        manageableModels: st.manageableModels.map((p) => ({
          ...p,
          models: p.models.map((m) => (`${p.id}/${m.id}` === ref ? { ...m, enabled } : m))
        }))
      }))
      await get().saveSettings(patch)
      await get().refreshManageableModels()
    },

    addCustomModel: async (model) => {
      const s = get().settings
      if (!s) return
      // Replace any existing entry with the same provider/id (custom wins).
      const customModels = [
        ...(s.customModels ?? []).filter(
          (c) => !(c.provider === model.provider && c.id === model.id)
        ),
        model
      ]
      set({ settings: { ...s, customModels } })
      await get().saveSettings({ customModels })
      await get().refreshManageableModels()
    },

    removeCustomModel: async (provider, id) => {
      const s = get().settings
      if (!s) return
      const ref = `${provider}/${id}`
      const customModels = (s.customModels ?? []).filter(
        (c) => !(c.provider === provider && c.id === id)
      )
      // Also drop any lingering opt-out for the removed ref, and clear the
      // default if it pointed at the removed model.
      const disabledModels = (s.disabledModels ?? []).filter((r) => r !== ref)
      const patch =
        s.defaultModelRef === ref
          ? { customModels, disabledModels, defaultModelRef: null }
          : { customModels, disabledModels }
      set({ settings: { ...s, ...patch } })
      await get().saveSettings(patch)
      await get().refreshManageableModels()
    },

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    setSidebarWidth: (w, options) => {
      const c = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))
      if (options?.persist !== false) writeStoredWidth('bearcode.sidebarWidth', c)
      set({ sidebarWidth: c })
    },
    setAuxPaneWidth: (w, options) => {
      const c = Math.min(AUX_MAX, Math.max(AUX_MIN, Math.round(w)))
      if (options?.persist !== false) writeStoredWidth('bearcode.auxPaneWidth', c)
      set({ auxPaneWidth: c })
    },
    toggleModelMenu: () => set((s) => ({ modelMenuTick: s.modelMenuTick + 1 })),
    goHome: () =>
      // New conversations start in the configured default (design section 3).
      // Reset the composer mode on the home transition so a mode carried over
      // from a just-viewed conversation cannot leak into the next new
      // conversation. An explicit pick on the home composer afterward still
      // wins, and close the pane -- its contents belong to the conversation
      // being left.
      set((s) => {
        if (s.pendingHomeConvoId || s.pendingHomeAttempt !== null) return s
        return {
          view: { kind: 'home' },
          // A Hermes conversation just left behind must not leak its sentinel
          // modelRef into the next new conversation's composer (it would render
          // in Hermes-lean mode with no model/mode pickers) -- reset it here
          // alongside the other draft state below.
          modelRef: s.settings?.defaultModelRef ?? URSA_MODEL_REF,
          permissionMode: s.settings?.defaultPermissionMode ?? 'accept-edits',
          effort: s.settings?.defaultEffort ?? 'adaptive',
          thinking: s.settings?.defaultThinking ?? true,
          // Ursa Mode has no settings default -- a fresh Home composer is Code.
          ursaMode: 'code',
          auxSelection: null,
          reviewFocusPath: null,
          // Abandoning Home drops any attachments already picked under the draft
          // id (a minor on-disk orphan, acceptable for v1 -- see D4 design note);
          // the next Home visit mints a fresh draft id on first Media use.
          draftConvoId: null,
          acceptedHomeConvoId: null,
          conversationDraftHandoff: null,
          // F3: a New-Worktree pick belongs to the conversation being left; the
          // next new conversation starts back at Local unless re-chosen.
          composerEnvironment: 'local'
        }
      }),
    openHistory: () =>
      set({ view: { kind: 'history' }, auxSelection: null, reviewFocusPath: null }),
    openTerminalView: (path: string) => {
      set({ view: { kind: 'terminal', path }, auxSelection: null })
    },
    openProjectPage: (path: string | null) => {
      set({ view: { kind: 'project', path }, auxSelection: null })
    },
    openProjectsIndex: () => {
      set({ view: { kind: 'projects' }, auxSelection: null, reviewFocusPath: null })
    },
    openModelsPage: () => {
      set({ view: { kind: 'models' }, auxSelection: null, reviewFocusPath: null })
    },
    createTerminalTab: async (path: string) => {
      const view = await window.bearcode.terminal.create(path)
      set((s) => {
        const existing = s.terminalTabs[path] ?? []
        return {
          terminalTabs: {
            ...s.terminalTabs,
            [path]: [...existing, { id: view.id, title: view.title, exited: false }]
          },
          activeTerminalTab: { ...s.activeTerminalTab, [path]: view.id }
        }
      })
    },
    closeTerminalTab: async (path: string, id: string) => {
      await window.bearcode.terminal.close(id)
      set((s) => {
        const remaining = (s.terminalTabs[path] ?? []).filter((t) => t.id !== id)
        const wasActive = s.activeTerminalTab[path] === id
        return {
          terminalTabs: { ...s.terminalTabs, [path]: remaining },
          activeTerminalTab: {
            ...s.activeTerminalTab,
            [path]: wasActive ? remaining.at(-1)?.id : s.activeTerminalTab[path]
          }
        }
      })
    },
    setActiveTerminalTab: (path: string, id: string) => {
      set((s) => ({ activeTerminalTab: { ...s.activeTerminalTab, [path]: id } }))
    },
    markTerminalTabExited: (path: string, id: string) => {
      set((s) => ({
        terminalTabs: {
          ...s.terminalTabs,
          [path]: (s.terminalTabs[path] ?? []).map((t) => (t.id === id ? { ...t, exited: true } : t))
        }
      }))
    },
    clearFocusEvent: () =>
      set((state) => ({
        focusEventId: null,
        focusMatches: [],
        focusRevision: state.focusRevision + 1
      })),
    setFocusMatches: (ids) =>
      set((state) => ({ focusMatches: ids, focusRevision: state.focusRevision + 1 })),
    // Walk the current match set (from a content-search jump) by one step,
    // clamped to the ends, and re-point focusEventId so ConversationView
    // re-scrolls + re-highlights. No-op when there's no match set.
    stepFocus: (dir) => {
      const { focusMatches, focusEventId } = get()
      if (focusMatches.length === 0) return
      const cur = focusEventId ? focusMatches.indexOf(focusEventId) : -1
      const next = Math.min(focusMatches.length - 1, Math.max(0, cur + dir))
      set((state) => ({
        focusEventId: focusMatches[next],
        focusRevision: state.focusRevision + 1
      }))
    },
    openConvo: (id, opts) => {
      const prev = get().view
      // Ba4: the pane renders the CURRENT conversation's entries and
      // diffs.get is a global lookup, so any actual view-target change closes
      // it -- a stale cross-conversation selection could show another
      // conversation's diff. Re-clicking the already-open conversation keeps
      // the pane.
      const switching = !(prev.kind === 'conversation' && prev.id === id)
      set((state) => ({
        view: { kind: 'conversation', id },
        // F1: a content-search hit passes the event to jump to; a plain open
        // (no opts) clears any stale pending focus so it can't fire later.
        focusEventId: opts?.focusEventId ?? null,
        // Match set for the next/prev navigator. Defaults to just the single
        // focused event (no navigator) when the caller doesn't supply one, and
        // clears entirely on a plain open.
        focusMatches: opts?.focusMatches ?? (opts?.focusEventId ? [opts.focusEventId] : []),
        focusRevision: state.focusRevision + 1,
        ...(switching ? { auxSelection: null, reviewFocusPath: null } : {})
      }))
      const convo = get().conversations[id]
      if (!convo) return
      // Restore the model the conversation last used.
      if (convo.modelRef && refConfigured(get().providers, convo.modelRef)) {
        set({ modelRef: convo.modelRef })
      }
      set({ permissionMode: convo.permissionMode })
      set({ effort: convo.effort, thinking: convo.thinking, webSearch: convo.webSearch })
      set({ ursaMode: convo.ursaMode })
      // Load history from the DB the first time a conversation is opened. A
      // live running conversation is already `loaded` (it was open when it
      // started), so guarding on `!loaded` avoids clobbering in-flight streamed
      // events with a stale read. 'awaiting-approval' is included for crash-
      // resume (A2): a conversation the app re-surfaced at boot is `!loaded`
      // with a persisted pending approval in its history that must be read in.
      if (!convo.loaded && (convo.runState === 'idle' || convo.runState === 'awaiting-approval')) {
        void window.bearcode.conversations
          .get(id)
          .then((events) => {
            // Derive awaiting-approval from a trailing pending tool_call: a crash-
            // resumed conversation (A2) persists its re-surfaced pending approval
            // to history, but the boot-time run-state broadcast can be lost to a
            // startup race, so reading it back from the loaded events is the
            // robust source of truth for the composer state.
            const last = events[events.length - 1]
            const pending = last && last.type === 'tool_call' && last.approvalState === 'pending'
            patchConvo(id, {
              events,
              loaded: true,
              ...(pending ? { runState: 'awaiting-approval' as const } : {})
            })
          })
          .catch((err) => {
            // A failed history load must still flip `loaded` so the UI doesn't
            // hang forever on a blank transcript with no way to retry.
            get().showToast(describeError(err))
            patchConvo(id, { loaded: true })
          })
      }
    },

    startFromHome: async (text, command, mentions, attachments) => {
      const { modelRef, workspacePath, pendingHomeConvoId, pendingHomeAttempt } = get()
      if (!modelRef || pendingHomeConvoId || pendingHomeAttempt !== null) return false
      const reservedDraftConvoId = get().ensureDraftConvoId()
      const attempt = nextHomeAttempt++
      set((state) => ({
        pendingHomeConvoId: reservedDraftConvoId,
        pendingHomeAttempt: attempt,
        ...(state.acceptedHomeConvoId ? { acceptedHomeConvoId: null } : {})
      }))
      try {
        // If Media was used on Home first, attachments are already on disk
        // under reservedDraftConvoId -- create the conversation AS that id so they
        // line up, instead of minting a second, unrelated id.
        // A prior rejected first dispatch leaves its created conversation as
        // the Home draft, so retry that exact id instead of orphaning it (and
        // any attachments already stored beneath it).
        let draftConvo = get().conversations[reservedDraftConvoId]
        if (!draftConvo) {
          const meta = await window.bearcode.conversations.create(
            workspacePath,
            reservedDraftConvoId
          )
          if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
          const createdConvo = fromMeta(meta)
          draftConvo = createdConvo
          set((s) => {
            const conversations = { ...s.conversations, [meta.id]: createdConvo }
            return {
              conversations,
              convoOrder: orderByRecency(conversations),
              draftConvoId: meta.id
            }
          })
        }
        const convoId = draftConvo.id
        // F9 (folder = project) inheritance on the PRIMARY entry point: a folder's
        // per-folder default model/effort/mode is the folder's opinion for
        // conversations that start in it. create() seeds a new folder's row from
        // newProjectDefaults main-side, so refresh first, then let a folder
        // override win over the live composer selection; where the folder is
        // silent, the composer's current choice stands (unlike the sidebar "+"
        // which falls back to global defaults). The refConfigured guard means an
        // unusable folder model falls back to the composer model — never start a
        // run on an unconfigured model.
        if (workspacePath) await get().refreshProjectSettings()
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        const folder = workspacePath
          ? (get().folderSettings.find((f) => f.path === workspacePath) ?? null)
          : null
        const permissionMode = folder?.defaultPermissionMode ?? get().permissionMode
        const effort = folder?.defaultEffort ?? get().effort
        const thinking = get().thinking
        const webSearch = get().webSearch
        // Ursa Mode has no folder/global default -- carry the composer's pick.
        const ursaMode = get().ursaMode
        const wantModel = folder?.defaultModelRef ?? null
        const runModel =
          wantModel && refConfigured(get().providers, wantModel) ? wantModel : modelRef
        const provisional = text.length > 42 ? text.slice(0, 42) + '…' : text
        const convo = {
          ...draftConvo,
          title: provisional,
          loaded: true,
          modelRef: runModel,
          permissionMode,
          effort,
          thinking,
          webSearch,
          ursaMode
        }
        set((s) => {
          const conversations = { ...s.conversations, [convoId]: convo }
          return {
            conversations,
            convoOrder: orderByRecency(conversations),
            draftConvoId: convoId,
            // Reflect the folder's inherited defaults in the composer for this
            // new session (mirrors newConversationInProject).
            modelRef: runModel,
            permissionMode,
            effort,
            ursaMode
          }
        })
        // Persist the mode before the run starts so the very first run_command
        // resolves the right mode. Await rather than fire-and-forget: do not rely
        // on IPC ordering for a security-sensitive default.
        await window.bearcode.conversations.setMode(convoId, permissionMode)
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        await window.bearcode.conversations.setEffort(convoId, effort)
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        await window.bearcode.conversations.setThinking(convoId, thinking)
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        await window.bearcode.conversations.setWebSearch(convoId, webSearch)
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        await window.bearcode.conversations.setUrsaMode(convoId, ursaMode)
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        // F3: lock the chosen environment before the first run. Worktree
        // provisioning happens main-side; a non-git folder degrades to local.
        const env = get().composerEnvironment
        if (env === 'worktree') {
          try {
            const updated = await window.bearcode.conversations.setEnvironment(convoId, 'worktree')
            if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
            patchConvo(convoId, { environment: updated.environment })
          } catch (e) {
            if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
            get().showToast(e instanceof Error ? e.message : 'Could not create worktree')
          }
        }
        await window.bearcode.run.start(
          convoId,
          text,
          runModel,
          workspacePath,
          command ?? null,
          mentions ?? null,
          attachments ?? null
        )
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return true
        set((state) =>
          state.pendingHomeConvoId === reservedDraftConvoId &&
          state.pendingHomeAttempt === attempt &&
          state.conversations[convoId]
            ? { acceptedHomeConvoId: convoId }
            : state
        )
        return true
      } catch (error) {
        if (!ownsHomeAttempt(reservedDraftConvoId, attempt)) return false
        set((state) =>
          state.pendingHomeConvoId === reservedDraftConvoId && state.pendingHomeAttempt === attempt
            ? { pendingHomeConvoId: null, pendingHomeAttempt: null }
            : state
        )
        get().showToast(describeError(error))
        return false
      }
    },

    completeHomeStart: (remainingDraft) =>
      set((state) => {
        const conversationId = state.acceptedHomeConvoId
        if (!conversationId || !state.conversations[conversationId]) return state
        return {
          view: { kind: 'conversation', id: conversationId },
          draftConvoId: null,
          pendingHomeConvoId: null,
          pendingHomeAttempt: null,
          acceptedHomeConvoId: null,
          conversationDraftHandoff: hasComposerDraftContent(remainingDraft)
            ? { conversationId, draft: remainingDraft }
            : null
        }
      }),

    consumeConversationDraftHandoff: (conversationId) =>
      set((state) =>
        state.conversationDraftHandoff?.conversationId === conversationId
          ? { conversationDraftHandoff: null }
          : state
      ),

    deleteConvo: (id) => {
      void window.bearcode.conversations.delete(id).then(() => {
        pruneConvoTracking(id, get().conversations[id]?.events ?? [])
        set((s) => {
          const conversations = { ...s.conversations }
          delete conversations[id]
          const view =
            s.view.kind === 'conversation' && s.view.id === id ? { kind: 'home' as const } : s.view
          return {
            conversations,
            convoOrder: orderByRecency(conversations),
            view,
            draftConvoId: s.draftConvoId === id ? null : s.draftConvoId,
            pendingHomeConvoId: s.pendingHomeConvoId === id ? null : s.pendingHomeConvoId,
            pendingHomeAttempt: s.pendingHomeConvoId === id ? null : s.pendingHomeAttempt,
            acceptedHomeConvoId: s.acceptedHomeConvoId === id ? null : s.acceptedHomeConvoId,
            conversationDraftHandoff:
              s.conversationDraftHandoff?.conversationId === id ? null : s.conversationDraftHandoff,
            // Landing back on home (deleted the active conversation): reset the
            // composer to the configured default so the next new conversation
            // starts there, not in the deleted conversation's mode.
            permissionMode:
              view.kind === 'home'
                ? (s.settings?.defaultPermissionMode ?? 'accept-edits')
                : s.permissionMode,
            effort: view.kind === 'home' ? (s.settings?.defaultEffort ?? 'adaptive') : s.effort,
            thinking: view.kind === 'home' ? (s.settings?.defaultThinking ?? true) : s.thinking,
            webSearch: view.kind === 'home' ? false : s.webSearch,
            ursaMode: view.kind === 'home' ? 'code' : s.ursaMode,
            auxSelection: view.kind === 'home' ? null : s.auxSelection,
            reviewFocusPath: view.kind === 'home' ? null : s.reviewFocusPath
          }
        })
        get().showToast('Conversation deleted')
      })
    },

    send: async (convoId, text, command, mentions, attachments) => {
      const {
        modelRef,
        conversations,
        pendingHomeConvoId,
        pendingHomeAttempt,
        view,
        focusRevision
      } = get()
      const convo = conversations[convoId]
      const provisionalHomeOwner = pendingHomeConvoId === convoId && pendingHomeAttempt !== null
      if (!modelRef || !convo || provisionalHomeOwner) return false
      const ownsFocus = view.kind === 'conversation' && view.id === convoId
      try {
        await window.bearcode.run.start(
          convoId,
          text,
          modelRef,
          convo.projectPath,
          command ?? null,
          mentions ?? null,
          attachments ?? null
        )
        // A new turn must never stay pinned to a prior history-search jump: clear
        // the focus target + match set so the accepted follow-up run's streamed
        // events don't fight auto-follow (F1).
        set((state) =>
          ownsFocus &&
          state.focusRevision === focusRevision &&
          state.view.kind === 'conversation' &&
          state.view.id === convoId
            ? {
                focusEventId: null,
                focusMatches: [],
                focusRevision: state.focusRevision + 1
              }
            : state
        )
        patchConvo(convoId, { modelRef })
        return true
      } catch (error) {
        get().showToast(describeError(error))
        return false
      }
    },

    cancelRun: (convoId) => {
      void window.bearcode.run.cancel(convoId)
    },

    approveTool: (callId, approved) => {
      void window.bearcode.tools.approve(callId, approved)
    },

    resolvePipeline: (convoId, callId, approved) => {
      void window.bearcode.ursa.resolvePipeline(convoId, callId, approved)
    },

    resolveReviewClarification: (conversationId, lens, scope) => {
      void window.bearcode.review.resolveClarify(conversationId, lens, scope)
    },

    resolveHermesApproval: (conversationId, requestId, decision) => {
      return window.bearcode.hermes.resolveApproval(conversationId, requestId, decision)
    },

    resolveHermesClarification: (conversationId, requestId, response) => {
      return window.bearcode.hermes.resolveClarification(conversationId, requestId, response)
    },

    addPermissionRule: (input) => {
      // Fire-and-forget for the approval-card call sites; the chained refresh
      // keeps an already-open manager list current.
      void window.bearcode.permissions.addRule(input).then(() => get().refreshPermissionRules())
    },

    refreshPermissionRules: async () => {
      set({ permissionRules: await window.bearcode.permissions.list() })
    },

    deletePermissionRule: async (id) => {
      try {
        await window.bearcode.permissions.deleteRule(id)
      } catch (err) {
        // A rejected mutation must not leave the store stale: re-fetch so the
        // UI reflects reality even though the delete itself failed.
        await get().refreshPermissionRules()
        throw err
      }
      await get().refreshPermissionRules()
    },

    setBuiltinDisabled: async (id, disabled) => {
      try {
        await window.bearcode.permissions.setBuiltinDisabled(id, disabled)
      } catch (err) {
        await get().refreshPermissionRules()
        throw err
      }
      await get().refreshPermissionRules()
    },

    retryRun: (convoId) => {
      const { conversations, modelRef } = get()
      if (!modelRef) return
      const convo = conversations[convoId]
      const lastUser = [...convo.events].reverse().find((e) => e.type === 'user_message')
      if (!lastUser || lastUser.type !== 'user_message') return
      // Retry resends WITHOUT a command (D2 Task 4, documented choice):
      // re-running a workflow on retry would be surprising, so only
      // lastUser.text is replayed even when the original turn carried one.
      void window.bearcode.run.start(convoId, lastUser.text, modelRef, convo.projectPath)
    },

    selectModel: (ref) => {
      set({ modelRef: ref })
      void window.bearcode.settings.set({ defaultModelRef: ref }).then((settings) => {
        set({ settings })
      })
    },

    setSidebarView: async (patch) => {
      const settings = await window.bearcode.settings.set(patch)
      set({ settings })
    },

    setAppearance: async (patch) => {
      // Apply optimistically for instant feedback, then persist. The persisted
      // result is authoritative (coerced custom colors etc.).
      const optimistic = { ...get().settings, ...patch } as SettingsInfo
      applyAppearance(optimistic)
      const settings = await window.bearcode.settings.set(patch)
      set({ settings })
      applyAppearance(settings)
    },

    syncPricing: async () => {
      // Main fetches + persists the prices (and clears its live-discovery
      // cache -- see registry.ts's clearLiveDiscoveryCache); re-fetch
      // settings so the freshly synced modelPricing/modelMetadata land in
      // the store, then refresh providers/manageableModels so any
      // newly-discovered live models actually appear -- clearing a
      // main-process-only cache does nothing to already-fetched renderer
      // state on its own.
      const result = await window.bearcode.pricing.sync()
      const settings = await window.bearcode.settings.get()
      set({ settings })
      await get().refreshProviders()
      await get().refreshManageableModels()
      return result
    },

    setPermissionMode: (mode) => {
      set({ permissionMode: mode })
      const view = get().view
      const id = view.kind === 'conversation' ? view.id : null
      if (id) {
        patchConvo(id, { permissionMode: mode })
        void window.bearcode.conversations.setMode(id, mode).catch(() => {})
      }
    },

    setEffort: (effort) => {
      set({ effort })
      const view = get().view
      const id = view.kind === 'conversation' ? view.id : null
      if (id) {
        patchConvo(id, { effort })
        void window.bearcode.conversations.setEffort(id, effort).catch(() => {})
      }
    },

    setUrsaMode: (mode) => {
      set({ ursaMode: mode })
      const view = get().view
      const id = view.kind === 'conversation' ? view.id : null
      if (id) {
        patchConvo(id, { ursaMode: mode })
        void window.bearcode.conversations.setUrsaMode(id, mode).catch(() => {})
      }
    },

    setThinking: (thinking) => {
      set({ thinking })
      const view = get().view
      const id = view.kind === 'conversation' ? view.id : null
      if (id) {
        patchConvo(id, { thinking })
        void window.bearcode.conversations.setThinking(id, thinking).catch(() => {})
      }
    },
    setWebSearch: (webSearch) => {
      set({ webSearch })
      const view = get().view
      const id = view.kind === 'conversation' ? view.id : null
      if (id) {
        patchConvo(id, { webSearch })
        void window.bearcode.conversations.setWebSearch(id, webSearch).catch(() => {})
      }
    },
    // F3: pure draft state for the Home composer's env picker. The environment
    // is only committed (main-side provisioning) at create in startFromHome /
    // newConversationInProject, then locked -- so this never touches IPC.
    setComposerEnvironment: (v) => set({ composerEnvironment: v }),

    // F3: merge a single repo's worktree branch into its base branch. Per-repo
    // so multi-repo merges are independent. A clean merge toasts; a conflict
    // opens the Monaco resolver (Task 12) by seeding the `conflict` slice with
    // the conflicted files to walk.
    mergeWorktree: async (convId, repoPath) => {
      try {
        const res = await window.bearcode.worktree.merge(convId, repoPath)
        if (res.status === 'conflict') {
          set({ conflict: { convId, repoPath, files: res.conflictedFiles, index: 0 } })
        } else {
          get().showToast('Merged to ' + (repoPath.split('/').pop() || repoPath))
        }
      } catch (e) {
        // git() rejects on any non-zero exit (dirty base repo, a merge already
        // in progress, lock contention, …). Surface it instead of leaving the
        // Merge button a silent no-op.
        get().showToast(e instanceof Error ? e.message : 'Merge failed')
      }
    },

    // F3: discard the whole conversation's worktrees (removes each + its branch,
    // main-side) and reset it to local so the action bar disappears.
    discardWorktree: async (convId) => {
      try {
        await window.bearcode.worktree.discard(convId)
        patchConvo(convId, { environment: 'local', worktrees: [] })
      } catch (e) {
        get().showToast(e instanceof Error ? e.message : 'Could not discard worktree')
      }
    },

    refreshProjectSettings: async () => {
      const folderSettings = await window.bearcode.projects.list()
      set({ folderSettings })
    },
    updateProject: async (path, patch) => {
      try {
        await window.bearcode.projects.update(path, patch)
        await get().refreshProjectSettings()
      } catch {
        // An IPC failure (e.g. path validation) must not surface as an unhandled
        // rejection; surface it and leave the modal's stored state as-is.
        get().showToast('Could not save project settings')
      }
    },
    toggleProjectPinned: async (path) => {
      const current = get().folderSettings.find((f) => f.path === path)?.pinned ?? false
      const next = !current
      // Patch in-memory state immediately (mirrors setPinned's conversation-pin
      // shape) so rapid double-clicks each read the just-toggled value instead of
      // racing on the same stale snapshot while the IPC round-trip is in flight.
      // No rollback on failure, matching updateProject's existing convention: its
      // catch already surfaces a toast and leaves stored state as-is rather than
      // reverting it.
      set((s) => ({
        folderSettings: s.folderSettings.map((f) => (f.path === path ? { ...f, pinned: next } : f))
      }))
      await get().updateProject(path, { pinned: next })
    },
    setAsNewProjectDefault: async (patch) => {
      await get().saveSettings({ newProjectDefaults: patch })
      get().showToast('Saved as the default for new projects')
    },
    openProjectSettings: (path) => set({ projectSettingsPath: path }),
    closeProjectSettings: () => set({ projectSettingsPath: null }),
    setPinned: (id, pinned) => {
      patchConvo(id, { pinned })
      void window.bearcode.conversations.setPinned(id, pinned).catch(() => {})
    },
    setArchived: (id, archived) => {
      patchConvo(id, { archived })
      void window.bearcode.conversations.setArchived(id, archived).catch(() => {})
      // Archiving is easy to fumble — offer an Undo (Antigravity parity).
      if (archived) {
        get().showToast('Conversation archived', {
          label: 'Undo',
          run: () => get().setArchived(id, false)
        })
      }
    },
    renameConversation: (id, title) => {
      patchConvo(id, { title })
      void window.bearcode.conversations.rename(id, title).catch(() => {})
    },
    newConversationInProject: async (path) => {
      try {
        // Folder = project: the conversation is created directly in the folder;
        // its projectPath IS the project link (no separate assignment step).
        const meta = await window.bearcode.conversations.create(path)
        // create() seeds a new folder's settings row from newProjectDefaults
        // main-side; refresh so a freshly-seeded row is visible before we resolve.
        await get().refreshProjectSettings()
        // F9 inheritance: a new conversation in a folder starts on that folder's
        // per-folder defaults (model/effort/permission mode), each falling back to
        // the global default when the folder leaves it unset. Effort + mode persist
        // per-conversation via IPC; model is the store's active selection (same as
        // selectModel). thinking stays global.
        const folder = get().folderSettings.find((f) => f.path === path) ?? null
        const settings = get().settings
        const d = resolveProjectDefaults(folder, {
          defaultModelRef: settings?.defaultModelRef ?? null,
          defaultEffort: settings?.defaultEffort ?? 'adaptive',
          defaultPermissionMode: settings?.defaultPermissionMode ?? 'accept-edits'
        })
        await window.bearcode.conversations.setMode(meta.id, d.permissionMode)
        await window.bearcode.conversations.setEffort(meta.id, d.effort)
        // Ursa Mode always starts at 'code' for a NEW conversation -- carrying the
        // previously open conversation's mode here would let a fresh "+"
        // conversation silently auto-start a paid Deep Research pipeline or a
        // ~7-call Council the user picked for a DIFFERENT conversation (final
        // review finding). Matches sendFromHome's reset-to-code behavior.
        const ursaMode: UrsaMode = 'code'
        await window.bearcode.conversations.setUrsaMode(meta.id, ursaMode)
        // F3: honor the composer's env pick on the sidebar "+" path too, locking
        // it before the first run (worktree provisioning is main-side; a non-git
        // folder degrades to local). A failure toasts and stays local.
        let newEnv: 'local' | 'worktree' = 'local'
        if (get().composerEnvironment === 'worktree') {
          try {
            const updated = await window.bearcode.conversations.setEnvironment(meta.id, 'worktree')
            newEnv = updated.environment
          } catch (e) {
            get().showToast(e instanceof Error ? e.message : 'Could not create worktree')
          }
        }
        // Only adopt the folder's default model if it is still usable (key
        // configured + present in the effective list). A since-removed key or an
        // F7-disabled model falls back to the current selection, mirroring the
        // refConfigured guard in openConvo/ensureDefaultModel — never silently
        // start a run on an unconfigured model.
        const modelRef = refConfigured(get().providers, d.modelRef) ? d.modelRef : get().modelRef
        const convo = {
          ...fromMeta(meta),
          loaded: true,
          permissionMode: d.permissionMode,
          effort: d.effort,
          ursaMode,
          environment: newEnv,
          modelRef
        }
        set((s) => {
          const conversations = { ...s.conversations, [meta.id]: convo }
          return {
            conversations,
            convoOrder: orderByRecency(conversations),
            view: { kind: 'conversation', id: meta.id },
            auxSelection: null,
            // Reflect the inherited defaults in the composer for the new session.
            modelRef,
            permissionMode: d.permissionMode,
            effort: d.effort,
            ursaMode
          }
        })
      } catch (e) {
        // Any of the IPC calls above (create/refreshProjectSettings/setMode/
        // setEffort/setUrsaMode) can reject; all 3 call sites (Sidebar,
        // ProjectsIndex, ProjectPage) invoke this fire-and-forget with no
        // .catch(), so an unhandled failure here previously vanished silently.
        get().showToast(describeError(e))
      }
    },

    newHermesConversation: async () => {
      // Hermes conversations are project-less -- there is no folder to inherit
      // defaults from (createHermes already seeds sensible ones main-side), so
      // this only mirrors newConversationInProject's state-write tail: build
      // the Convo from the returned meta and switch the active view to it.
      const mode = get().settings?.hermesConnectionMode === 'native' ? 'native' : 'legacy'
      const meta = await window.bearcode.conversations.createHermes(mode)
      const convo = { ...fromMeta(meta), loaded: true }
      set((s) => {
        const conversations = { ...s.conversations, [meta.id]: convo }
        return {
          conversations,
          convoOrder: orderByRecency(conversations),
          view: { kind: 'conversation', id: meta.id },
          auxSelection: null,
          // Mirror newConversationInProject/openConvo: the composer's transient
          // top-level modelRef must be synced to the sentinel immediately, or
          // send()/retryRun() dispatch under whatever model was last active
          // (and corrupt the conversation's persisted modelRef) until the
          // conversation is closed and reopened.
          modelRef: HERMES_MODEL_REF
        }
      })
    },
    testHermesConnection: (mode, url, secret) =>
      window.bearcode.hermes.testConnection(mode, url, secret),
    saveHermesToken: (token) => window.bearcode.hermes.setLegacyToken(token),
    saveHermesPlatformKey: (key) => window.bearcode.hermes.setPlatformKey(key),

    togglePermMenu: () => set((s) => ({ permMenuTick: s.permMenuTick + 1 })),

    pickWorkspace: async () => {
      const path = await window.bearcode.workspace.pick()
      if (path) get().setWorkspace(path)
    },
    setWorkspace: (path) => {
      set({ workspacePath: path })
      void get().refreshTrustState(path)
      void get().refreshImportBannerState(path)
    },
    refreshTrustState: async (path) => {
      if (!path) {
        set({
          workspaceTrusted: false,
          workspaceHasAgentsConfig: false,
          outsideAccess: null,
          trustBannerDismissed: false
        })
        return
      }
      const [trusted, hasConfig, outsideAccess] = await Promise.all([
        window.bearcode.project.isTrusted(path),
        window.bearcode.project.hasConfig(path),
        window.bearcode.project.outsideAccess.get(path)
      ])
      set({
        workspaceTrusted: trusted,
        workspaceHasAgentsConfig: hasConfig,
        outsideAccess,
        trustBannerDismissed: false
      })
    },
    trustWorkspace: async () => {
      const path = get().workspacePath
      if (!path) return
      await window.bearcode.project.trust(path)
      await get().refreshProjectSettings()
      set({ workspaceTrusted: true })
    },
    dismissTrustBanner: () => set({ trustBannerDismissed: true }),
    refreshImportBannerState: async (path) => {
      if (!path) {
        set({ workspaceImportCandidates: [], workspaceImportBannerVisible: false })
        return
      }
      const { candidates, showBanner } = await window.bearcode.configImport.scan(path)
      set({ workspaceImportCandidates: candidates, workspaceImportBannerVisible: showBanner })
    },
    dismissImportBanner: async () => {
      const path = get().workspacePath
      if (!path) return
      const sourcePaths = get()
        .workspaceImportCandidates.filter((c) => c.kind !== 'unsupported')
        .map((c) => c.sourcePath)
      await window.bearcode.configImport.dismiss(path, sourcePaths)
      set({ workspaceImportBannerVisible: false })
    },
    openImportReview: () => set({ importReviewOpen: true }),
    closeImportReview: () => set({ importReviewOpen: false }),
    applyImportSelection: async (selection) => {
      const path = get().workspacePath
      if (!path) throw new Error('no workspace open')
      const summary = await window.bearcode.configImport.apply(path, selection)
      set({ importReviewOpen: false, workspaceImportBannerVisible: false })
      // The modal is already animating closed by the time its own .then() could
      // render a summary line, so the confirmation has to be a toast (final
      // review Finding 3) -- otherwise a successful import looked like nothing
      // happened at all.
      const parts: string[] = []
      if (summary.rulesImported > 0) parts.push(plural(summary.rulesImported, 'rule'))
      if (summary.workflowsImported > 0) parts.push(plural(summary.workflowsImported, 'workflow'))
      if (summary.skillsImported > 0) parts.push(plural(summary.skillsImported, 'skill'))
      if (summary.mcpServersImported > 0) parts.push(plural(summary.mcpServersImported, 'connector'))
      get().showToast(parts.length === 0 ? 'Nothing was imported' : `Imported ${parts.join(', ')}`)
      // refreshTrustState too, not just the banner state (final review Finding
      // 4): if the project had no .agents/ before this import,
      // workspaceHasAgentsConfig is still false, so TrustBanner would never
      // show, the user would never be prompted to trust the folder, and the
      // rules just written would never actually load (untrusted = not loaded).
      await Promise.all([get().refreshImportBannerState(path), get().refreshTrustState(path)])
      return summary
    },
    checkForUpdates: async () => {
      const status = await window.bearcode.updater.checkNow()
      set({ updaterStatus: status })
    },
    installUpdate: () => {
      window.bearcode.updater.installNow()
    },
    dismissUpdateBanner: () => set({ updateBannerDismissed: true }),
    allowOutside: async (abs) => {
      const path = get().workspacePath
      if (!path) return
      const outsideAccess = await window.bearcode.project.outsideAccess.allow(path, abs)
      set({ outsideAccess })
    },
    denyOutside: async (abs) => {
      const path = get().workspacePath
      if (!path) return
      const outsideAccess = await window.bearcode.project.outsideAccess.deny(path, abs)
      set({ outsideAccess })
    },
    removeOutside: async (path, abs) => {
      await window.bearcode.project.outsideAccess.remove(path, abs)
      await get().refreshProjectSettings()
      void get().refreshTrustState(path)
    },
    toggleProjectMenu: () => set((s) => ({ projectMenuTick: s.projectMenuTick + 1 })),

    openSettings: (page) => set({ settingsOpen: true, settingsInitialPage: page ?? null }),
    closeSettings: () => set({ settingsOpen: false }),

    saveKey: async (provider, key) => {
      await window.bearcode.keys.set(provider, key)
      await get().refreshProviders()
      get().showToast(key ? 'API key saved' : 'API key removed')
    },

    saveSettings: async (patch) => {
      const settings = await window.bearcode.settings.set(patch)
      set({ settings })
      // Refresh the effective model set whenever the model roster changes so
      // every picker/meter reflects opt-out + Add-model immediately (F7).
      if (
        patch.ollamaBaseUrl !== undefined ||
        patch.disabledModels !== undefined ||
        patch.customModels !== undefined ||
        patch.enabledLiveModels !== undefined
      )
        await get().refreshProviders()
    },

    deleteAllConversations: async () => {
      await window.bearcode.conversations.clear()
      turnStartByConvo.clear()
      workedSecondsByTurn.clear()
      browserPaneAutoOpened.clear()
      set((s) => ({
        conversations: {},
        convoOrder: [],
        view: { kind: 'home' },
        draftConvoId: null,
        pendingHomeConvoId: null,
        pendingHomeAttempt: null,
        acceptedHomeConvoId: null,
        conversationDraftHandoff: null,
        permissionMode: s.settings?.defaultPermissionMode ?? 'accept-edits',
        auxSelection: null,
        reviewFocusPath: null
      }))
      get().showToast('All conversations deleted')
    },

    openReview: (diffId) =>
      set((s) => ({
        auxSelection: { kind: 'diff', diffId },
        reviewFocusPath: null,
        auxPaneOpenTick: s.auxPaneOpenTick + 1
      })),
    openReviewForFile: (convoId, path) => {
      const convo = get().conversations[convoId]
      if (!convo) return
      const name = path.split('/').pop() ?? path
      for (let i = convo.events.length - 1; i >= 0; i--) {
        const ev = convo.events[i]
        if (ev.type !== 'file_diff') continue
        const match = ev.files.find(
          (f) => f.path === path || f.path.endsWith('/' + name) || f.path === name
        )
        if (match) {
          set((s) => ({
            auxSelection: { kind: 'diff', diffId: ev.diffId },
            reviewFocusPath: match.path,
            auxPaneOpenTick: s.auxPaneOpenTick + 1
          }))
          return
        }
      }
    },
    openFile: (path) => {
      const view = get().view
      if (view.kind !== 'conversation') return
      void window.bearcode.shell
        .openFile(view.id, path)
        .catch(() => get().showToast('Could not open that file'))
    },
    openFileInPane: (path, line) =>
      set((s) => ({
        auxSelection: { kind: 'file', path, line },
        reviewFocusPath: null,
        auxPaneOpenTick: s.auxPaneOpenTick + 1
      })),

    openArtifactPane: (artifactId, focusFeedback) =>
      set((s) => ({
        auxSelection: { kind: 'artifact', artifactId },
        reviewFocusPath: null,
        auxPaneOpenTick: s.auxPaneOpenTick + 1,
        artifactPaneFocusFeedback: focusFeedback
          ? s.artifactPaneFocusFeedback + 1
          : s.artifactPaneFocusFeedback
      })),

    openAttachmentPane: (conversationId, attachmentId) =>
      set((s) => ({
        auxSelection: { kind: 'attachment', conversationId, attachmentId },
        reviewFocusPath: null,
        auxPaneOpenTick: s.auxPaneOpenTick + 1
      })),

    openBrowserPane: (conversationId) =>
      set((s) => ({
        auxSelection: { kind: 'browser', conversationId },
        reviewFocusPath: null,
        auxPaneOpenTick: s.auxPaneOpenTick + 1
      })),

    loadArtifactComments: async (artifactId) => {
      const comments = await window.bearcode.artifacts.listComments(artifactId)
      set((s) => ({ artifactComments: { ...s.artifactComments, [artifactId]: comments } }))
    },

    addArtifactComment: async (artifactId, quote, body) => {
      await window.bearcode.artifacts.addComment(artifactId, quote, body)
      await get().loadArtifactComments(artifactId)
    },

    addDiffReviewComment: (diffId, comment) =>
      set((s) => ({
        diffReviewComments: {
          ...s.diffReviewComments,
          [diffId]: [
            ...(s.diffReviewComments[diffId] ?? []),
            { id: `review-comment-${nextReviewCommentId++}`, ...comment }
          ]
        }
      })),

    removeDiffReviewComment: (diffId, commentId) =>
      set((s) => ({
        diffReviewComments: {
          ...s.diffReviewComments,
          [diffId]: (s.diffReviewComments[diffId] ?? []).filter(
            (comment) => comment.id !== commentId
          )
        }
      })),

    clearDiffReviewComments: (diffId, commentIds) =>
      set((s) => {
        const diffReviewComments = { ...s.diffReviewComments }
        if (commentIds === undefined) {
          delete diffReviewComments[diffId]
        } else {
          const ids = new Set(commentIds)
          const remaining = (diffReviewComments[diffId] ?? []).filter(
            (comment) => !ids.has(comment.id)
          )
          if (remaining.length === 0) delete diffReviewComments[diffId]
          else diffReviewComments[diffId] = remaining
        }
        return { diffReviewComments }
      }),

    beginDiffReviewSend: (diffId) => {
      if (get().diffReviewSending[diffId]) return false
      set((s) => ({
        diffReviewSending: { ...s.diffReviewSending, [diffId]: true }
      }))
      return true
    },

    finishDiffReviewSend: (diffId) =>
      set((s) => {
        const diffReviewSending = { ...s.diffReviewSending }
        delete diffReviewSending[diffId]
        return { diffReviewSending }
      }),

    // Plan reviews resolve over their own channel, never tools.approve
    // (main-side kind cross-guards make the wires mutually exclusive). The
    // failure copy discriminates on the main-side result, never guesses:
    // 'stale' (card answered/stopped/unknown) vs 'needs-substance' (design
    // 3.6's Review guard).
    resolvePlanReview: async (callId, proceed, message) => {
      // The conversation this callId's plan review belongs to is whichever
      // conversation is open right now (both call sites -- the pending card
      // and the artifact pane -- only render for the active view). Captured
      // before the await: the mode flip below must target the conversation
      // that actually asked, not wherever the view has drifted to by the
      // time the main process answers.
      const view = get().view
      const convoId = view.kind === 'conversation' ? view.id : null
      const result = await window.bearcode.artifacts.resolvePlanReview(callId, proceed, message)
      if (result === 'needs-substance') {
        get().showToast('Add a comment or a message before sending a review')
      } else if (result === 'stale') {
        get().showToast('This plan review is no longer pending')
      } else if (result === 'resolved' && proceed && convoId) {
        // Mirror graph.ts planProceedModeFlip/resolvePlanInterrupt: Proceed
        // conditionally relaxes plan-mode read-only so the resumed run can
        // implement (design §5). Only when STILL in `plan` -- never on the
        // Review path, and never overwriting a mode the user manually picked
        // during the pause. The per-conversation record is always updated to
        // match the server's durable state; the top-level surface (what the
        // mode picker renders) only follows along if this conversation is
        // still the one on screen, matching setPermissionMode/openConvo.
        if (get().conversations[convoId]?.permissionMode === 'plan') {
          patchConvo(convoId, { permissionMode: 'accept-edits' })
          const current = get().view
          if (current.kind === 'conversation' && current.id === convoId) {
            set({ permissionMode: 'accept-edits' })
          }
        }
      }
      return result === 'resolved'
    },

    // propose_skill resolves over its own channel too (bearcode:skills:save),
    // mirroring resolvePlanReview: main-side kind cross-guards keep this
    // mutually exclusive from tools.approve. 'stale' is the only failure
    // discriminant (no needs-substance analog); the terminal tool_call event
    // re-renders the card as resolved either way, so a successful save is a
    // no-op here beyond dismissing the toast path.
    resolveSkillProposal: async (callId, resolution) => {
      const result = await window.bearcode.skills.save(callId, resolution)
      if (result === 'stale') {
        get().showToast('This skill proposal is no longer pending')
      }
    },

    closeReview: () => set({ auxSelection: null, reviewFocusPath: null }),

    showToast: (message, action) => {
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: { message, action } })
      // Action toasts (e.g. archive Undo) linger so there's time to click;
      // plain notices auto-dismiss quickly.
      toastTimer = setTimeout(() => set({ toast: null }), action ? 6000 : 1800)
    },
    dismissToast: () => {
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: null })
    },

    // Menu-open paced (design 3.1's cache already backs the main-side loader,
    // so a fresh list per open is cheap). The active project is the open
    // conversation's, or the Home composer's picked workspace when there is
    // no conversation yet.
    refreshCommands: () => {
      const projectPath = activeProjectPath()
      void window.bearcode.commands.list(projectPath).then((commands) => set({ commands }))
    },

    // Query-driven (called as the @-file query changes). The active project is
    // the open conversation's, or the Home composer's picked workspace.
    suggestFiles: (query) => {
      const projectPath = activeProjectPath()
      void window.bearcode.mentions
        .files(projectPath, query)
        .then((files) => set({ fileSuggestions: files }))
    },

    // Fetched once on @ menu open (mirrors refreshCommands' pacing).
    refreshManualRules: () => {
      const projectPath = activeProjectPath()
      void window.bearcode.mentions.rules(projectPath).then((manualRules) => set({ manualRules }))
    },

    // The @skill category's read model (mirrors refreshManualRules). Fetched
    // on @ menu open.
    refreshManualSkills: () => {
      const projectPath = activeProjectPath()
      void window.bearcode.mentions
        .skills(projectPath)
        .then((manualSkills) => set({ manualSkills }))
    },

    // Enabled + connected MCP servers for the @connector category. Fetched on @
    // menu open (mirrors refreshManualRules). A server contributes to the menu
    // only when the master gate is on, it is individually enabled, and it has a
    // live tool list — i.e. exactly the servers whose tools the agent can call.
    refreshMcpConnectors: () => {
      const projectPath = activeProjectPath()
      void window.bearcode.mcp.ensureConnected(projectPath).then((servers) =>
        set({
          mcpConnectors: servers
            .filter((s) => s.enabled && s.status.state === 'connected')
            .map((s) => ({
              name: s.config.name,
              toolCount: s.status.state === 'connected' ? s.status.tools.length : 0
            }))
        })
      )
    },

    setResumePickerOpen: (open) => set({ resumePickerOpen: open }),

    // D4 Media: opens the native image picker for the active conversation and
    // returns the ingested results. An open conversation uses its real id;
    // Home (no conversation yet) uses the lazily-minted draft id so Media
    // works before the first send, the primary use case (see ensureDraftConvoId).
    pickAttachments: async (existingCount) => {
      const { view } = get()
      const conversationId = view.kind === 'conversation' ? view.id : get().ensureDraftConvoId()
      return window.bearcode.attachments.pick(conversationId, existingCount)
    },

    // Lazily mints (once) and returns a client-side placeholder conversation
    // id for Home's Media picker, entirely sync -- no server round trip -- so
    // the very first Media click on a brand-new conversation has an id to key
    // the attachments directory by. startFromHome later creates the real
    // conversation AS this id (see above) so the two line up.
    ensureDraftConvoId: () => {
      const existing = get().draftConvoId
      if (existing) return existing
      const id = crypto.randomUUID()
      set({ draftConvoId: id })
      return id
    }
  }
})
