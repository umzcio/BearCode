import type { PreviewPayload } from '../../shared/types'
import { extractTextLane } from '../attachments/extract'
import { runOfficeHtml, runOfficeRows } from '../attachments/office'
import { previewClassify } from './classify'
import { parseCsv } from './csv'

export interface PreviewSource {
  name: string
  mime: string
  bytes: Buffer
  htmlUrl: string
}

export async function renderPreviewPayload(source: PreviewSource): Promise<PreviewPayload> {
  const classification = previewClassify(source.name)
  if (classification.kind === 'image') {
    const ext = (source.name.split('.').pop() ?? 'png').toLowerCase()
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return { kind: 'image', dataUrl: `data:${mime};base64,${source.bytes.toString('base64')}` }
  }
  if (classification.kind === 'svg') {
    return {
      kind: 'image',
      dataUrl: `data:image/svg+xml;base64,${source.bytes.toString('base64')}`
    }
  }
  if (classification.kind === 'pdf') {
    return {
      kind: 'pdf',
      dataUrl: `data:application/pdf;base64,${source.bytes.toString('base64')}`
    }
  }
  if (classification.kind === 'docx') {
    const html = await runOfficeHtml(source.bytes)
    return html
      ? { kind: 'html', html }
      : { kind: 'unsupported', note: 'Could not render document' }
  }
  if (classification.kind === 'xlsx') {
    const rows = await runOfficeRows(source.bytes)
    return rows
      ? { kind: 'table', rows }
      : { kind: 'unsupported', note: 'Could not render spreadsheet' }
  }
  if (classification.kind === 'markdown') {
    return { kind: 'markdown', text: source.bytes.toString('utf8') }
  }
  if (classification.kind === 'csv') {
    return { kind: 'table', rows: parseCsv(source.bytes.toString('utf8')) }
  }
  if (classification.kind === 'json') {
    const text = source.bytes.toString('utf8')
    let pretty = text
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      pretty = text
    }
    return { kind: 'code', text: pretty, language: 'json' }
  }
  if (classification.kind === 'code') {
    return {
      kind: 'code',
      text: source.bytes.toString('utf8'),
      language: classification.language ?? 'plaintext'
    }
  }
  if (classification.kind === 'html') {
    return { kind: 'html-url', url: source.htmlUrl }
  }
  const result = extractTextLane(source.bytes)
  return { kind: 'text', text: result.text, truncated: result.truncated }
}
