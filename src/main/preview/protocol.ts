// bearcode-preview:// -- a custom protocol that serves HTML previews with a
// real origin of their own, replacing the old blob-URL + asset-inlining
// approach (the removed inlineHtml.ts). A blob: document inherits the RENDERER's CSP,
// whose tight script-src rightly blocks agent-authored page scripts -- so any
// site whose visibility depends on JS (scroll reveals, charts) previewed
// blank, and images could never load at all (they were never inlined). With
// its own origin the preview gets its own, per-response CSP: page scripts run
// THERE without loosening the app's CSP one bit, and relative css/js/image
// references resolve naturally against the URL.
//
// URL shape: bearcode-preview://preview/<fileId>/<relative path>
//   - fixed "preview" host: URL parsing lowercases hosts, so the fileId must
//     ride in the path where its case survives.
//   - <fileId> resolves through the diffs DB (filePathFor) exactly like the
//     bearcode:diffs:preview IPC -- never a raw renderer-supplied path.
//   - <relative path> resolves against the PREVIEWED FILE's directory and is
//     jailed to that directory tree (realpath on both sides, same discipline
//     as the old inlineHtml readLocalAsset): absolute paths, .. escapes, and
//     symlinks pointing out of the tree all 404.
//
// SECURITY posture vs the old blob preview: the iframe keeps sandbox
// (allow-scripts, no allow-same-origin -> opaque origin, no parent access,
// no window.bearcode). The served CSP allows scripts but NO network: no
// http(s) source appears in any directive, so a malicious page can't
// exfiltrate; it can only read files inside the previewed directory tree,
// which the agent that authored it could already read.
import { app, protocol } from 'electron'
import { readFileSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'path'
import { filePathFor } from '../diffs'
import { assertValidAttachmentId, assertValidConversationId } from '../attachments/ingest'
import {
  readVerifiedStoredAttachment,
  type VerifiedStoredAttachment
} from '../hermes/attachmentAccess'
import * as db from '../db'

export const PREVIEW_SCHEME = 'bearcode-preview'
const PREVIEW_HOST = 'preview'
const ATTACHMENT_HOST = 'attachment'
const ASSET_MAX = 25 * 1024 * 1024

// The preview document's OWN policy (scoped to this origin; the app's CSP in
// renderer/index.html is untouched). Scheme sources are listed alongside
// 'self' because the sandboxed iframe has an opaque origin, and scheme
// matching is robust where 'self' can be implementation-picky. Deliberately
// ABSENT: http:, https:, ws: anywhere -- the preview cannot talk to the
// network at all.
export const PREVIEW_CSP = [
  "default-src 'none'",
  `script-src 'self' ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `style-src 'self' ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `img-src 'self' ${PREVIEW_SCHEME}: data: blob:`,
  `font-src 'self' ${PREVIEW_SCHEME}: data:`,
  `media-src 'self' ${PREVIEW_SCHEME}: data: blob:`,
  `connect-src 'self' ${PREVIEW_SCHEME}: data: blob:`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain'
}

export function mimeFor(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// The iframe src for a previewed HTML file. Each path segment of the file's
// name is encoded so spaces/unicode survive URL parsing.
export function previewUrlFor(fileId: string, htmlPath: string): string {
  const name = encodeURIComponent(basename(htmlPath))
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}/${encodeURIComponent(fileId)}/${name}`
}

export function attachmentPreviewUrlFor(
  conversationId: string,
  attachmentId: string,
  displayName: string
): string {
  return `${PREVIEW_SCHEME}://${ATTACHMENT_HOST}/${encodeURIComponent(conversationId)}/${encodeURIComponent(attachmentId)}/${encodeURIComponent(displayName)}`
}

// PURE-ish resolution (fs reads only): URL pathname -> jailed absolute file
// path, or null for anything that isn't a real file inside the previewed
// file's directory tree. `lookup` is injectable for tests; production callers
// use the diffs-DB filePathFor.
export function resolvePreviewPath(
  pathname: string,
  lookup: (fileId: string) => string | null = filePathFor
): string | null {
  const segments = pathname.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null
  let fileId: string
  let relSegments: string[]
  try {
    fileId = decodeURIComponent(segments[0])
    relSegments = segments.slice(1).map((s) => decodeURIComponent(s))
  } catch {
    return null // malformed percent-encoding
  }
  const htmlPath = lookup(fileId)
  if (!htmlPath) return null
  const rel = relSegments.join('/')
  try {
    const realRoot = realpathSync(dirname(htmlPath))
    const target = rel.length > 0 ? resolve(realRoot, rel) : resolve(realRoot, basename(htmlPath))
    const realTarget = realpathSync(target)
    const relCheck = relative(realRoot, realTarget)
    if (relCheck.startsWith('..') || isAbsolute(relCheck)) return null // escaped the tree
    const st = statSync(realTarget)
    if (!st.isFile() || st.size > ASSET_MAX) return null
    return realTarget
  } catch {
    return null // missing / unreadable / dangling symlink
  }
}

// Must run BEFORE app ready (Electron requirement). `standard` gives the
// scheme real URL semantics so relative references resolve; supportFetchAPI
// lets in-page fetch() read same-tree files (e.g. a data.json the agent
// wrote next to index.html).
export function registerPreviewSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

interface PreviewRequestDependencies {
  filePathFor?: (fileId: string) => string | null
  readAttachment?: (
    conversationId: string,
    attachmentId: string
  ) => Promise<VerifiedStoredAttachment>
}

function previewResponse(bytes: Buffer, mime: string): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': mime,
      'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
  })
}

export async function handlePreviewRequest(
  request: Request,
  dependencies: PreviewRequestDependencies = {}
): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('bad request', { status: 400 })
  }

  if (url.host === PREVIEW_HOST) {
    const path = resolvePreviewPath(url.pathname, dependencies.filePathFor ?? filePathFor)
    if (!path) return new Response('not found', { status: 404 })
    try {
      return previewResponse(readFileSync(path), mimeFor(path))
    } catch {
      return new Response('not found', { status: 404 })
    }
  }

  if (url.host === ATTACHMENT_HOST) {
    const encodedSegments = url.pathname.split('/').slice(1)
    if (encodedSegments.length !== 3 || encodedSegments.some((segment) => segment.length === 0)) {
      return new Response('not found', { status: 404 })
    }

    let decodedSegments: string[]
    try {
      decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment))
      const [conversationId, attachmentId] = decodedSegments
      assertValidConversationId(conversationId)
      assertValidAttachmentId(attachmentId)
    } catch {
      return new Response('bad request', { status: 400 })
    }

    if (!dependencies.readAttachment) return new Response('not found', { status: 404 })
    try {
      const [conversationId, attachmentId] = decodedSegments
      const verified = await dependencies.readAttachment(conversationId, attachmentId)
      return previewResponse(verified.bytes, mimeFor(verified.attachment.name))
    } catch {
      return new Response('not found', { status: 404 })
    }
  }

  return new Response('not found', { status: 404 })
}

// Must run AFTER app ready.
export function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    return handlePreviewRequest(request, {
      readAttachment: (conversationId, attachmentId) =>
        readVerifiedStoredAttachment(
          app.getPath('userData'),
          conversationId,
          attachmentId,
          db.getEvents(conversationId)
        )
    })
  })
}
