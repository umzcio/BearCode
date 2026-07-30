import type { BodyView } from './types'

export const RAIL_CONTENT_PANEL_ID = 'artifacts-rail-content'
export const REVIEW_MODE_CONTENT_PANEL_ID = 'artifacts-review-mode-content'
export const FILE_CONTENT_PANEL_ID = 'artifacts-file-content'
export const BODY_VIEW_CONTENT_PANEL_ID = 'artifacts-body-view-content'

export function railTabId(id: string): string {
  return `artifacts-rail-tab-${id}`
}

export function reviewModeTabId(mode: 'overview' | 'diff'): string {
  return `artifacts-review-mode-tab-${mode}`
}

export function fileTabId(fileId: string): string {
  return `artifacts-file-tab-${fileId}`
}

export function bodyViewTabId(fileId: string, view: BodyView): string {
  return `artifacts-body-view-tab-${fileId}-${view}`
}
