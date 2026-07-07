// Make an HTML file self-contained for the sandboxed preview iframe.
//
// The preview renders HTML in a srcDoc iframe with an opaque origin and no base
// URL, so relative `<link rel=stylesheet href>` and `<script src>` can't
// resolve -- the page shows unstyled. Here we inline those LOCAL sibling assets
// (read from disk) so the preview matches a real browser load.
//
// SECURITY: only files that resolve WITHIN the HTML file's own directory tree
// are inlined; absolute paths, URLs (any scheme), protocol-relative refs, and
// anything that escapes the dir via `..` are left untouched. Assets over 2 MB
// are skipped. Callers hand us a trusted on-disk path (from the diffs DB).
import { readFileSync, statSync, realpathSync } from 'fs'
import { dirname, resolve, relative, isAbsolute } from 'path'

const ASSET_MAX = 2 * 1024 * 1024

// Read a local asset referenced from an HTML file, or null if it isn't a
// jailed, in-tree, reasonably-sized local file.
function readLocalAsset(htmlDir: string, ref: string): string | null {
  const cleaned = ref.split('#')[0].split('?')[0].trim()
  if (!cleaned) return null
  // Any URL scheme (http:, data:, file:, mailto:), protocol-relative //host,
  // or an absolute filesystem path -> not a jailed relative sibling; skip.
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) || cleaned.startsWith('//') || cleaned.startsWith('/')) {
    return null
  }
  try {
    const realDir = realpathSync(htmlDir)
    const realAsset = realpathSync(resolve(realDir, cleaned))
    const rel = relative(realDir, realAsset)
    if (rel.startsWith('..') || isAbsolute(rel)) return null // escaped the dir tree
    if (statSync(realAsset).size > ASSET_MAX) return null
    return readFileSync(realAsset, 'utf8')
  } catch {
    return null // missing / unreadable / not a real path
  }
}

// Runs INSIDE the preview iframe to make in-page "#id" links scroll: a
// sandboxed blob iframe (no allow-same-origin) refuses to navigate to its own
// blob: URL, so the native fragment nav is blocked -- no blank, but no scroll
// either. This tiny script does the scroll instead. It's permitted by a CSP
// script hash (script-src stays tight, no 'unsafe-inline').
//
// IF YOU EDIT GUARD_JS: recompute its sha256 (base64) and update BOTH
// GUARD_SHA256 below AND the 'sha256-...' entry in src/renderer/index.html's
// CSP. The inlineHtml test asserts GUARD_SHA256 matches, so drift fails CI.
export const GUARD_JS = `(function(){document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)!=="#")return;e.preventDefault();var el=h.length>1?document.getElementById(h.slice(1)):null;if(el&&el.scrollIntoView)el.scrollIntoView({behavior:"smooth",block:"start"});else window.scrollTo({top:0,behavior:"smooth"});},true);})();`
export const GUARD_SHA256 = 'oVJj0ACHgjG/RZ5w2908a8qWT6bTNLDaHDj8NB3aoYE='

export function injectPreviewNavGuard(html: string): string {
  const tag = `<script>${GUARD_JS}</script>`
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>')
  return html + tag
}

export function inlineHtmlAssets(html: string, htmlPath: string): string {
  const dir = dirname(htmlPath)

  // Inline <link rel="stylesheet" href="..."> as <style>...</style>.
  let out = html.replace(/<link\b[^>]*?>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i)
    if (!m) return tag
    const css = readLocalAsset(dir, m[1])
    return css != null ? `<style>\n${css}\n</style>` : tag
  })

  // Inline <script src="..."></script>, preserving other attrs (e.g. type=module).
  out = out.replace(
    /<script\b([^>]*?)\ssrc\s*=\s*["']([^"']+)["']([^>]*?)>([\s\S]*?)<\/script>/gi,
    (tag, pre: string, src: string, post: string) => {
      const js = readLocalAsset(dir, src)
      return js != null ? `<script${pre}${post}>\n${js}\n</script>` : tag
    }
  )

  return out
}
