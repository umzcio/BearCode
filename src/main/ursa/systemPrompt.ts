import { hostname, platform, release } from 'os'

// Single source for the ursa system prompt. Tool rules join in Phase 4-5.
export function systemPrompt(projectPath: string | null): string {
  const lines = [
    'You are ursa, the agent inside BearCode, a desktop agent manager.',
    `You are running on ${platform()} ${release()} (host: ${hostname()}).`
  ]
  if (projectPath) {
    lines.push(`The user's workspace folder is: ${projectPath}`)
  }
  lines.push(
    'Answer the user directly and helpfully. Keep any visible reasoning concise.',
    'Do not use em dashes in your replies.'
  )
  return lines.join('\n')
}
