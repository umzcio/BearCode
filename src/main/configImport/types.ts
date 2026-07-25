export type ImportTool = 'claude-code' | 'codex' | 'cursor' | 'windsurf'
export type ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported'

export interface DetectedSource {
  sourcePath: string
  kind: ImportKind
  tool: ImportTool
}

// Mirrors shared/types.ts's ImportCandidate field-for-field (same reason the
// DetectedSource/ImportKind/ImportTool triple is duplicated there: main-only
// modules must not be imported by the renderer). See that declaration for the
// rationale behind each field.
export interface ImportCandidate extends DetectedSource {
  buildable: boolean
  preview?: string
  warnings?: string[]
}
