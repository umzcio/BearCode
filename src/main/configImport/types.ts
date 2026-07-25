export type ImportTool = 'claude-code' | 'codex' | 'cursor' | 'windsurf'
export type ImportKind = 'rule' | 'workflow' | 'skill' | 'unsupported'

export interface DetectedSource {
  sourcePath: string
  kind: ImportKind
  tool: ImportTool
}
