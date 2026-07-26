import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import { MAX_IMPORT_BYTES } from './hash'
import type { DetectedSource } from './types'

export interface WorkflowCandidate {
  sourcePath: string
  suggestedName: string
  body: string
  warnings: string[]
}

function nameFromSourcePath(sourcePath: string): string {
  const base = sourcePath.split(/[/\\]/).pop() ?? sourcePath
  const stem = base.replace(/\.md$/, '')
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function buildWorkflowCandidate(
  projectPath: string,
  source: DetectedSource
): WorkflowCandidate | null {
  const abs = join(projectPath, source.sourcePath)
  const read = readFileCapped(abs, MAX_IMPORT_BYTES, projectPath)
  if (!read || read.text.trim() === '') return null

  const suggestedName = nameFromSourcePath(source.sourcePath)
  if (!COMMAND_NAME_PATTERN.test(suggestedName)) return null

  return {
    sourcePath: source.sourcePath,
    suggestedName,
    body: read.text,
    warnings: read.truncated
      ? [`${source.sourcePath} exceeds ${MAX_IMPORT_BYTES / 1024}KB and was truncated`]
      : []
  }
}
