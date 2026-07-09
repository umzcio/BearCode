export interface DomainPolicy {
  allowlist: string[]
  blocklist: string[]
}
export interface CdpTarget {
  url: string
  type: string
  id: string
}

export function normalizeOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return null
  }
}

export function originDecision(url: string, policy: DomainPolicy): 'allow' | 'block' | 'prompt' {
  const origin = normalizeOrigin(url)
  if (!origin) return 'prompt'
  const norm = (l: string[]): string[] => l.map((x) => normalizeOrigin(x) ?? x.toLowerCase())
  if (norm(policy.blocklist).includes(origin)) return 'block'
  const allow = norm(policy.allowlist)
  if (allow.length === 0) return 'allow'
  return allow.includes(origin) ? 'allow' : 'prompt'
}

// Select the CDP page target for our view by exact URL, else same-origin page.
// CRITICAL: the app's own renderer is also a CDP target; matching by the view's
// current URL (never a blanket "first page") keeps Playwright off the app UI.
export function matchBrowserTarget(targets: CdpTarget[], viewUrl: string): CdpTarget | null {
  const pages = targets.filter((t) => t.type === 'page')
  const exact = pages.find((t) => t.url === viewUrl)
  if (exact) return exact
  const vo = normalizeOrigin(viewUrl)
  return pages.find((t) => vo && normalizeOrigin(t.url) === vo) ?? null
}
