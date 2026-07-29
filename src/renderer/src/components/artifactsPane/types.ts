import type { FileDiff } from '@shared/types'

export type BodyView = 'diff' | 'code' | 'preview'

export type DiffLoadState =
  | { status: 'loading'; diffId: string }
  | { status: 'ready'; diffId: string; diff: FileDiff }
  | { status: 'error'; diffId: string }
