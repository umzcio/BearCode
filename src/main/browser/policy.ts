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

// The host a policy entry gates. Accepts scheme-qualified ('https://evil.com'),
// bare ('evil.com'), and host:port ('evil.com:8080') forms — a bare entry (the
// most natural thing a user types in the Settings UI) used to normalize to a
// value that could never equal an origin, making the L2 gate a silent no-op
// (finding 5). We reduce every entry to a bare lowercase host and match by host
// suffix, scheme-agnostically, so a single entry covers http/https and
// subdomains but not look-alikes.
function entryHost(entry: string): string | null {
  const e = entry.trim().toLowerCase()
  if (!e) return null
  if (e.includes('://')) {
    try {
      return new URL(e).host || null
    } catch {
      return null
    }
  }
  // Bare form: strip any accidental path/query the user pasted.
  const host = e.split(/[/?#]/)[0]
  return host || null
}

// host matches entry itself or is a subdomain of it (dot boundary prevents a
// 'notevil.com' vs 'evil.com' look-alike bypass).
function hostMatchesEntry(host: string, entryH: string): boolean {
  return host === entryH || host.endsWith(`.${entryH}`)
}

export function originDecision(url: string, policy: DomainPolicy): 'allow' | 'block' | 'prompt' {
  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return 'prompt'
  }
  if (!host) return 'prompt'
  const matches = (list: string[]): boolean =>
    list.some((entry) => {
      const eh = entryHost(entry)
      return eh != null && hostMatchesEntry(host, eh)
    })
  if (matches(policy.blocklist)) return 'block'
  if (policy.allowlist.length === 0) return 'allow'
  return matches(policy.allowlist) ? 'allow' : 'prompt'
}

// Select the index of the CDP page whose URL carries our unique per-session
// token. SECURITY-CRITICAL: BrowserManager embeds this token in the view's
// initial URL, so the ONLY page it matches is our WebContentsView — never the
// app's own renderer, another BearCode instance's targets, or a stale zombie
// page from a prior session (each session mints a fresh token). Returns -1 when
// nothing matches; the caller MUST refuse rather than fall back positionally.
export function indexOfPageWithToken(urls: string[], token: string): number {
  if (!token) return -1
  return urls.findIndex((u) => u.includes(token))
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
