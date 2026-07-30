import { Suspense, lazy } from 'react'
import type { FileDiffFile } from '@shared/types'
import { languageForPath } from '@shared/fileClassification'
import { useRovingTabs } from '../../lib/useRovingTabs'
import { FilePreview } from '../FilePreview/FilePreview'
import { Loading } from '../ui/Loading'
import { baseName } from './format'
import {
  BODY_VIEW_CONTENT_PANEL_ID,
  FILE_CONTENT_PANEL_ID,
  RAIL_CONTENT_PANEL_ID,
  REVIEW_MODE_CONTENT_PANEL_ID,
  bodyViewTabId,
  fileTabId,
  reviewModeTabId
} from './ids'
import type { BodyView } from './types'

const MonacoDiff = lazy(() => import('../MonacoDiff'))
const MonacoCode = lazy(() => import('../MonacoCode'))

export function DiffPanelContent({
  rail,
  railVisible,
  railPanelLabelledBy,
  mode,
  turnPrompt,
  files,
  activeFile,
  body,
  cmdHeld,
  emptyDiffState,
  setMode,
  setActiveFileId,
  setViewFor,
  openFile,
  commentedLines,
  addComment
}: {
  rail: React.ReactNode
  railVisible: boolean
  railPanelLabelledBy?: string
  mode: 'overview' | 'diff'
  turnPrompt: string
  files: FileDiffFile[]
  activeFile?: FileDiffFile
  body: BodyView
  cmdHeld: boolean
  emptyDiffState: React.ReactNode
  setMode: (mode: 'overview' | 'diff') => void
  setActiveFileId: (fileId: string) => void
  setViewFor: (fileId: string, view: BodyView) => void
  openFile: (path: string, line?: number) => void
  commentedLines: (path: string) => number[]
  addComment: (path: string) => (line: number, text: string) => void
}): React.JSX.Element {
  const fileTabIds = files.map((file) => file.fileId)
  const { tablistRef: fileTabsRef, onKeyDown: onFileTabsKeyDown } = useRovingTabs({
    ids: fileTabIds,
    selectedId: activeFile?.fileId,
    onActivate: setActiveFileId
  })
  const bodyViewIds: BodyView[] = ['diff', 'code', 'preview']
  const { tablistRef: bodyViewRef, onKeyDown: onBodyViewKeyDown } = useRovingTabs({
    ids: bodyViewIds,
    selectedId: body,
    onActivate: (nextView) => {
      if (activeFile) setViewFor(activeFile.fileId, nextView as BodyView)
    }
  })

  return (
    <>
      {rail}

      <div
        className="ap-rail-content"
        role={railVisible ? 'tabpanel' : 'region'}
        id={railVisible ? RAIL_CONTENT_PANEL_ID : undefined}
        aria-labelledby={railVisible ? railPanelLabelledBy : undefined}
        aria-label={railVisible ? undefined : 'Diff review content'}
      >
        <div
          className="ap-mode-content"
          role="tabpanel"
          id={REVIEW_MODE_CONTENT_PANEL_ID}
          aria-labelledby={reviewModeTabId(mode)}
        >
          {mode === 'overview' ? (
            <div className="ap-overview">
              <div className="overview-title">Overview</div>
              {turnPrompt ? <div className="overview-prompt">{turnPrompt}</div> : null}
              <div className="overview-sub">
                {files.length} file{files.length === 1 ? '' : 's'} changed
              </div>
              {files.map((f) => (
                <button
                  key={f.fileId}
                  className="overview-file"
                  onClick={() => {
                    setActiveFileId(f.fileId)
                    setMode('diff')
                  }}
                >
                  <span className="code-mark">{'</>'}</span>
                  <span className="fname">{baseName(f.path)}</span>
                  {f.state === 'reverted' ? (
                    <span className="file-state reverted">Reverted</span>
                  ) : (
                    <span className="stats">
                      <span className="plus">+{f.additions}</span>
                      <span className="minus">-{f.deletions}</span>
                    </span>
                  )}
                </button>
              ))}
              {files.length === 0 ? <div className="diff-loading">{emptyDiffState}</div> : null}
            </div>
          ) : (
            <>
              {/* Row 2: file tabs + Diff/Code/Preview toggle */}
              <div className="ap-row ap-row-tabs">
                <div
                  ref={fileTabsRef}
                  className="ap-tabs"
                  role="tablist"
                  aria-label="Changed files"
                  onKeyDown={onFileTabsKeyDown}
                >
                  {files.map((f) => (
                    <button
                      key={f.fileId}
                      id={fileTabId(f.fileId)}
                      role="tab"
                      data-roving-tab-id={f.fileId}
                      aria-controls={FILE_CONTENT_PANEL_ID}
                      aria-selected={f.fileId === activeFile?.fileId}
                      tabIndex={f.fileId === activeFile?.fileId ? 0 : -1}
                      className={
                        'ap-tab' +
                        (f.fileId === activeFile?.fileId ? ' active' : '') +
                        (cmdHeld ? ' cmd-openable' : '')
                      }
                      title={cmdHeld ? 'Cmd-click to open in editor' : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) openFile(f.path)
                        else setActiveFileId(f.fileId)
                      }}
                    >
                      <span className="code-mark">{'</>'}</span>
                      <span>{baseName(f.path)}</span>
                      {f.state === 'reverted' ? (
                        <span className="ap-diffstat">
                          <span className="reverted">Reverted</span>
                        </span>
                      ) : (
                        <span className="ap-diffstat">
                          <span className="add">+{f.additions}</span>
                          <span className="rem">-{f.deletions}</span>
                        </span>
                      )}
                      {f.fileId === activeFile?.fileId ? (
                        <svg
                          className="ap-clawmark"
                          width="16"
                          height="6"
                          viewBox="0 0 16 6"
                          aria-hidden="true"
                        >
                          <path d="M1 5 L5.3 1" />
                          <path d="M5.3 5 L9.7 1" />
                          <path d="M9.7 5 L14 1" />
                        </svg>
                      ) : null}
                    </button>
                  ))}
                </div>
                {activeFile ? (
                  <div
                    ref={bodyViewRef}
                    className="ap-segmented"
                    role="tablist"
                    aria-label="File view"
                    onKeyDown={onBodyViewKeyDown}
                  >
                    <button
                      id={bodyViewTabId(activeFile.fileId, 'diff')}
                      role="tab"
                      data-roving-tab-id="diff"
                      aria-controls={BODY_VIEW_CONTENT_PANEL_ID}
                      aria-selected={body === 'diff'}
                      tabIndex={body === 'diff' ? 0 : -1}
                      className={body === 'diff' ? 'active' : ''}
                      onClick={() => setViewFor(activeFile.fileId, 'diff')}
                    >
                      Diff
                    </button>
                    <button
                      id={bodyViewTabId(activeFile.fileId, 'code')}
                      role="tab"
                      data-roving-tab-id="code"
                      aria-controls={BODY_VIEW_CONTENT_PANEL_ID}
                      aria-selected={body === 'code'}
                      tabIndex={body === 'code' ? 0 : -1}
                      className={body === 'code' ? 'active' : ''}
                      onClick={() => setViewFor(activeFile.fileId, 'code')}
                    >
                      Code
                    </button>
                    <button
                      id={bodyViewTabId(activeFile.fileId, 'preview')}
                      role="tab"
                      data-roving-tab-id="preview"
                      aria-controls={BODY_VIEW_CONTENT_PANEL_ID}
                      aria-selected={body === 'preview'}
                      tabIndex={body === 'preview' ? 0 : -1}
                      className={body === 'preview' ? 'active' : ''}
                      onClick={() => setViewFor(activeFile.fileId, 'preview')}
                    >
                      Preview
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Body */}
              <div
                className="ap-body"
                role={activeFile ? 'tabpanel' : undefined}
                id={activeFile ? FILE_CONTENT_PANEL_ID : undefined}
                aria-labelledby={activeFile ? fileTabId(activeFile.fileId) : undefined}
              >
                {!activeFile ? (
                  <div className="diff-loading">{emptyDiffState}</div>
                ) : (
                  <div
                    role="tabpanel"
                    id={BODY_VIEW_CONTENT_PANEL_ID}
                    aria-labelledby={bodyViewTabId(activeFile.fileId, body)}
                    className="ap-body-view-content"
                  >
                    {body === 'preview' ? (
                      <FilePreview fileId={activeFile.fileId} />
                    ) : body === 'code' ? (
                      <Suspense fallback={<Loading />}>
                        <MonacoCode
                          key={activeFile.fileId + ':code'}
                          value={activeFile.afterText}
                          language={languageForPath(activeFile.path)}
                          commentedLines={commentedLines(activeFile.path)}
                          onAddComment={addComment(activeFile.path)}
                        />
                      </Suspense>
                    ) : (
                      <Suspense fallback={<Loading />}>
                        {activeFile.status === 'created' ? (
                          <MonacoCode
                            key={activeFile.fileId + ':diff'}
                            value={activeFile.afterText}
                            language={languageForPath(activeFile.path)}
                            commentedLines={commentedLines(activeFile.path)}
                            onAddComment={addComment(activeFile.path)}
                            washAdded
                          />
                        ) : (
                          <MonacoDiff
                            key={activeFile.fileId + ':diff'}
                            original={activeFile.beforeText}
                            modified={activeFile.afterText}
                            language={languageForPath(activeFile.path)}
                            commentedLines={commentedLines(activeFile.path)}
                            onAddComment={addComment(activeFile.path)}
                          />
                        )}
                      </Suspense>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
