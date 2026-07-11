export interface SandboxPolicy {
  writeRoots: string[] // realpath'd dirs the command may write under
  readDenyPaths: string[] // realpath'd sensitive files/dirs reads are denied
  allowNetwork: boolean
}

export interface SandboxPlan {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface SandboxRunner {
  available(): boolean
  wrap(command: string, cwd: string, policy: SandboxPolicy): SandboxPlan
}
