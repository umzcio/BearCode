import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import ExcelJS from 'exceljs'

export type DocFormat = 'docx' | 'xlsx' | 'pdf'

// Content is markdown-ish plain text: '# '/'## ' become headings, tab-separated
// lines become xlsx columns. Deliberately simple — rich layout is out of scope.
export async function generateDocument(format: DocFormat, content: string): Promise<Buffer> {
  if (format === 'docx') return generateDocx(content)
  if (format === 'xlsx') return generateXlsx(content)
  if (format === 'pdf') return generatePdf(content)
  throw new Error(`Unsupported document format: ${String(format)}`)
}

async function generateDocx(content: string): Promise<Buffer> {
  const paragraphs = content.split('\n').map((line) => {
    if (line.startsWith('## ')) return new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 })
    if (line.startsWith('# ')) return new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 })
    return new Paragraph({ children: [new TextRun(line)] })
  })
  const doc = new Document({ sections: [{ children: paragraphs }] })
  return Buffer.from(await Packer.toBuffer(doc))
}

async function generateXlsx(content: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const line of content.split('\n')) ws.addRow(line.split('\t'))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function generatePdf(content: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const size = 11
  const margin = 50
  const lineHeight = size * 1.5
  let page = pdf.addPage()
  let y = page.getSize().height - margin
  const maxWidth = page.getSize().width - margin * 2
  const draw = (text: string): void => {
    if (y < margin) {
      page = pdf.addPage()
      y = page.getSize().height - margin
    }
    page.drawText(text, { x: margin, y, size, font })
    y -= lineHeight
  }
  for (const raw of content.split('\n')) {
    if (raw === '') {
      y -= lineHeight
      continue
    }
    // Naive word wrap to the page width.
    let line = ''
    for (const word of raw.split(' ')) {
      const trial = line ? line + ' ' + word : word
      if (line && font.widthOfTextAtSize(trial, size) > maxWidth) {
        draw(line)
        line = word
      } else {
        line = trial
      }
    }
    draw(line)
  }
  return Buffer.from(await pdf.save())
}
