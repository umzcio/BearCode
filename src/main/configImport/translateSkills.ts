import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { parseSkillFolder } from '../agentsDir/parseSkill'
import type { DetectedSource } from './types'

const MAX_IMPORT_BYTES = 64 * 1024

export interface SkillCandidate {
  sourcePath: string
  suggestedName: string
  description: string
}

export function buildSkillCandidate(
  projectPath: string,
  source: DetectedSource
): SkillCandidate | null {
  const folderName = source.sourcePath.split(/[/\\]/).pop() ?? source.sourcePath
  const skillMdPath = join(projectPath, source.sourcePath, 'SKILL.md')
  const read = readFileCapped(skillMdPath, MAX_IMPORT_BYTES)
  if (!read) return null

  const parsed = parseSkillFolder(folderName, read.text, 'project')
  if (parsed.error) return null

  return {
    sourcePath: source.sourcePath,
    suggestedName: parsed.name,
    description: parsed.description
  }
}
