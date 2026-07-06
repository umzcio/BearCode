// Minimal RFC-4180-ish CSV parser for the preview table renderer: quoted
// fields, escaped `""`, and commas/newlines inside quotes. Not a full CSV
// dialect engine (no custom delimiters) -- previews only need "does this
// render as a sane table", not spreadsheet-grade parsing.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < len) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      pushField()
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      pushRow()
      i++
      continue
    }
    field += c
    i++
  }
  // Avoid a trailing empty row from a trailing newline, but still flush a
  // final row when the text doesn't end in one.
  if (field.length > 0 || row.length > 0) {
    pushRow()
  }
  return rows
}
