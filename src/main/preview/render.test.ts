import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewPayload } from '../../shared/types'

const { runOfficeHtml, runOfficeRows } = vi.hoisted(() => ({
  runOfficeHtml: vi.fn(),
  runOfficeRows: vi.fn()
}))

vi.mock('../attachments/office', () => ({
  runOfficeHtml,
  runOfficeRows
}))

import { renderPreviewPayload, type PreviewSource } from './render'

interface PreviewCase {
  label: string
  source: PreviewSource
  expected: PreviewPayload
}

const source = (name: string, text: string, mime = 'application/octet-stream'): PreviewSource => ({
  name,
  mime,
  bytes: Buffer.from(text),
  htmlUrl: 'bearcode-preview://attachment/conv_123/att_123/display.html'
})

beforeEach(() => {
  vi.clearAllMocks()
  runOfficeHtml.mockResolvedValue('<p>Rendered document</p>')
  runOfficeRows.mockResolvedValue([
    ['Name', 'Count'],
    ['Bears', '2']
  ])
})

describe('renderPreviewPayload', () => {
  it.each<PreviewCase>([
    {
      label: 'PNG bytes as an image data URL',
      source: source('photo.png', '\u0089PNG'),
      expected: { kind: 'image', dataUrl: 'data:image/png;base64,wolQTkc=' }
    },
    {
      label: 'JPEG bytes as an image data URL',
      source: source('photo.jpeg', '\u00ff\u00d8\u00ff'),
      expected: { kind: 'image', dataUrl: 'data:image/jpeg;base64,w7/DmMO/' }
    },
    {
      label: 'SVG bytes as an image data URL',
      source: source('icon.svg', '<svg/>'),
      expected: { kind: 'image', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }
    },
    {
      label: 'PDF bytes as a PDF data URL',
      source: source('report.pdf', '%PDF'),
      expected: { kind: 'pdf', dataUrl: 'data:application/pdf;base64,JVBERg==' }
    },
    {
      label: 'Markdown bytes as markdown',
      source: source('notes.md', '# Bears'),
      expected: { kind: 'markdown', text: '# Bears' }
    },
    {
      label: 'CSV bytes as a table',
      source: source('counts.csv', 'name,count\nbears,2'),
      expected: {
        kind: 'table',
        rows: [
          ['name', 'count'],
          ['bears', '2']
        ]
      }
    },
    {
      label: 'XLSX bytes as a table',
      source: source('counts.xlsx', 'real xlsx fixture bytes'),
      expected: {
        kind: 'table',
        rows: [
          ['Name', 'Count'],
          ['Bears', '2']
        ]
      }
    },
    {
      label: 'DOCX bytes as sandboxable HTML',
      source: source('report.docx', 'real docx fixture bytes'),
      expected: { kind: 'html', html: '<p>Rendered document</p>' }
    },
    {
      label: 'JSON bytes as pretty code',
      source: source('config.json', '{"enabled":true}'),
      expected: {
        kind: 'code',
        text: '{\n  "enabled": true\n}',
        language: 'json'
      }
    },
    {
      label: 'known source bytes as classified code',
      source: source('worker.ts', 'const bears = 2'),
      expected: { kind: 'code', text: 'const bears = 2', language: 'typescript' }
    },
    {
      label: 'HTML as the caller-provided URL',
      source: source('page.html', '<h1>Bears</h1>'),
      expected: {
        kind: 'html-url',
        url: 'bearcode-preview://attachment/conv_123/att_123/display.html'
      }
    },
    {
      label: 'plain text bytes as text',
      source: source('readme.txt', 'Bear facts'),
      expected: { kind: 'text', text: 'Bear facts', truncated: false }
    }
  ])('renders $label', async ({ source: input, expected }) => {
    await expect(renderPreviewPayload(input)).resolves.toEqual(expected)
  })

  it('falls back to the original JSON text when parsing fails', async () => {
    await expect(renderPreviewPayload(source('broken.json', '{"broken"'))).resolves.toEqual({
      kind: 'code',
      text: '{"broken"',
      language: 'json'
    })
  })

  it.each([
    {
      label: 'DOCX extraction failure',
      input: source('report.docx', 'docx bytes'),
      fail: () => runOfficeHtml.mockResolvedValue(null),
      expected: { kind: 'unsupported', note: 'Could not render document' }
    },
    {
      label: 'XLSX extraction failure',
      input: source('report.xlsx', 'xlsx bytes'),
      fail: () => runOfficeRows.mockResolvedValue(null),
      expected: { kind: 'unsupported', note: 'Could not render spreadsheet' }
    }
  ])('returns unsupported for $label', async ({ input, fail, expected }) => {
    fail()
    await expect(renderPreviewPayload(input)).resolves.toEqual(expected)
  })
})
