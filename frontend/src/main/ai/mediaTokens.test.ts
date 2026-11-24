import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { contextBudgetTokens, estimateChars, projectTokens } from './contextBudget'
import { IMAGE_TOKENS, PDF_PAGE_TOKENS, embeddedFileTokens, pdfPageCount } from './mediaTokens'
import type { ChatMessage } from './providers/types'

const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')

/** A PDF whose page objects stand in plain text, with `padding` bytes of an embedded image stream —
 *  the bulk that makes a short PDF large. */
function plainPdf(pages: number, padding = 0): Buffer {
  const objects = Array.from(
    { length: pages },
    (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`
  ).join('')
  return Buffer.concat([
    latin1(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`),
    latin1(`2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${objects}`),
    latin1(`99 0 obj\n<< /Type /XObject /Subtype /Image /Length ${padding} >>\nstream\n`),
    randomBytes(padding),
    latin1('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
  ])
}

/** A PDF 1.5 file with its page objects inside a compressed object stream, as pdfTeX and Word write it. */
function objectStreamPdf(
  pages: number,
  opts: { dict?: string; payload?: Buffer; plainPages?: number; streams?: number } = {}
): Buffer {
  const inner = latin1('<< /Type /Pages /Count 2 >> ' + '<< /Type /Page /Parent 2 0 R >> '.repeat(pages))
  const packed = opts.payload ?? deflateSync(inner)
  const dict =
    opts.dict ?? `/Type /ObjStm /N ${pages + 1} /First 20 /Filter /FlateDecode /Length ${packed.length}`
  const stream = Buffer.concat([
    latin1(`7 0 obj\n<< ${dict} >>\nstream\n`),
    packed,
    latin1('\nendstream\nendobj\n')
  ])
  const plain = '<< /Type /Page /Parent 2 0 R >>\n'.repeat(opts.plainPages ?? 0)
  return Buffer.concat([
    latin1(`%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n${plain}`),
    ...Array.from({ length: opts.streams ?? 1 }, () => stream),
    latin1('%%EOF\n')
  ])
}

const pdfUrl = (pdf: Buffer): string => `data:application/pdf;base64,${pdf.toString('base64')}`

describe('pdfPageCount', () => {
  it('counts page objects in plain text, not the nodes of the page tree', () => {
    expect(pdfPageCount(plainPdf(3))).toBe(3)
    // `/Type/Page` without a space is the same object.
    expect(pdfPageCount(latin1('%PDF-1.7\n1 0 obj <</Type/Page/Parent 2 0 R>> endobj\n%%EOF'))).toBe(1)
  })

  it('counts the pages inside compressed object streams', () => {
    expect(pdfPageCount(objectStreamPdf(5))).toBe(5)
  })

  it('takes the page count a linearised PDF states, but never below the pages it can count', () => {
    const header = (n: number): string =>
      `%PDF-1.6\n1 0 obj\n<< /Linearized 1 /L 99999 /H [ 640 220 ] /O 4 /E 5000 /N ${n} /T 98000 >>\nendobj\n`
    expect(pdfPageCount(latin1(header(183)))).toBe(183)
    // A file updated after it was linearised: the stated count is stale, the page objects are not.
    expect(pdfPageCount(latin1(header(1) + '<< /Type /Page >>\n'.repeat(3)))).toBe(3)
  })

  it('says it cannot tell for something that is not a PDF, or shows no pages', () => {
    expect(pdfPageCount(latin1('<html><body>not a pdf</body></html>'))).toBeNull()
    expect(pdfPageCount(Buffer.concat([latin1('%PDF-1.7\n'), randomBytes(5_000)]))).toBeNull()
  })

  it('gives no count rather than a partial one when an object stream cannot be read', () => {
    // Each of these PDFs shows one page in plain text; the rest sit in a stream it cannot open.
    const other = objectStreamPdf(5, {
      plainPages: 1,
      dict: '/Type /ObjStm /N 6 /First 20 /Filter /LZWDecode'
    })
    expect(pdfPageCount(other)).toBeNull()
    const chain = objectStreamPdf(5, {
      plainPages: 1,
      dict: '/Type /ObjStm /Filter [ /ASCII85Decode /FlateDecode ]'
    })
    expect(pdfPageCount(chain)).toBeNull()
    const predictor = objectStreamPdf(5, {
      plainPages: 1,
      dict: '/Type /ObjStm /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >>'
    })
    expect(pdfPageCount(predictor)).toBeNull()
    const damaged = objectStreamPdf(5, { plainPages: 1, payload: randomBytes(2_000) })
    expect(pdfPageCount(damaged)).toBeNull()
    // Flate as a one-entry array is the same encoding.
    expect(
      pdfPageCount(objectStreamPdf(5, { plainPages: 1, dict: '/Type/ObjStm/Filter[/FlateDecode]' }))
    ).toBe(6)
  })

  it('stops at what all object streams together may unpack to: a decompression bomb stays packed', () => {
    // 70 MB of zeros pack to about 70 KB; together with a page it is past the 64 MB all streams may unpack to.
    const bomb = deflateSync(Buffer.concat([latin1('<< /Type /Page >> '), Buffer.alloc(70 * 1024 * 1024)]))
    expect(pdfPageCount(objectStreamPdf(0, { payload: bomb }))).toBeNull()
  })

  it('stops after a bounded number of object streams', () => {
    expect(pdfPageCount(objectStreamPdf(1, { streams: 50 }))).toBe(50)
    expect(pdfPageCount(objectStreamPdf(1, { streams: 2_001 }))).toBeNull()
  })
})

describe('embeddedFileTokens', () => {
  it('prices a PDF by its pages, whatever its bytes weigh', () => {
    const holder = { filename: 'sheet.pdf', file_data: pdfUrl(plainPdf(10, 3_000_000)) }
    expect(embeddedFileTokens(holder, 'file_data', holder.file_data)).toBe(10 * PDF_PAGE_TOKENS)
  })

  it('reads the base64 source block a provider hands back for an opened PDF', () => {
    const source = {
      type: 'base64',
      media_type: 'application/pdf',
      data: plainPdf(4, 50_000).toString('base64')
    }
    expect(embeddedFileTokens(source, 'data', source.data)).toBe(4 * PDF_PAGE_TOKENS)
  })

  it('caps an image, and leaves a small one at its base64 estimate', () => {
    const big = { url: `data:image/png;base64,${randomBytes(400_000).toString('base64')}` }
    expect(embeddedFileTokens(big, 'url', big.url)).toBe(IMAGE_TOKENS)
    const small = { url: `data:image/png;base64,${randomBytes(4_000).toString('base64')}` }
    const tokens = embeddedFileTokens(small, 'url', small.url)
    expect(tokens).toBeLessThan(IMAGE_TOKENS)
    expect(tokens).toBe(Math.ceil((small.url.length - 'data:image/png;base64,'.length) / 4))
  })

  it('counts a PDF it cannot read as it always did, never lower', () => {
    const data = randomBytes(300_000).toString('base64')
    const source = { type: 'base64', media_type: 'application/pdf', data }
    expect(embeddedFileTokens(source, 'data', data)).toBe(Math.ceil(data.length / 4))
  })

  it('leaves text alone: a text document, a long tool result, a base64 string without a type', () => {
    const text = 'x'.repeat(50_000)
    expect(
      embeddedFileTokens({ type: 'text', media_type: 'text/plain', data: text }, 'data', text)
    ).toBeNull()
    expect(embeddedFileTokens({ content: text }, 'content', text)).toBeNull()
    const b64 = randomBytes(30_000).toString('base64')
    expect(embeddedFileTokens({ encrypted_content: b64 }, 'encrypted_content', b64)).toBeNull()
  })

  it('leaves a data URL written as text alone: a provider sends it as text, and it costs that much', () => {
    const url = `data:image/png;base64,${randomBytes(400_000).toString('base64')}`
    expect(embeddedFileTokens({ type: 'text', text: url }, 'text', url)).toBeNull()
    const msgs: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: url }] }]
    expect(estimateChars(msgs)).toBeGreaterThan(url.length)
  })
})

describe('estimateChars with embedded files', () => {
  // A 10-page data sheet of 3 MB: 4 million characters as base64, 40,000 tokens as pages.
  const sheet = plainPdf(10, 3_000_000)
  const asText = sheet.toString('base64').length

  it('counts an attached PDF by its pages', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is the GWP on page 4?' },
          { type: 'file', file: { filename: 'sheet.pdf', file_data: pdfUrl(sheet) } },
          { type: 'text', text: '[attached file: sheet.pdf — id "a1"]' }
        ]
      }
    ]
    const chars = estimateChars(msgs)
    expect(chars).toBeGreaterThanOrEqual(10 * PDF_PAGE_TOKENS * 4)
    expect(chars).toBeLessThan(10 * PDF_PAGE_TOKENS * 4 + 1_000)
    expect(chars).toBeLessThan(asText / 20)
  })

  it('counts a PDF the provider opened inside a round’s replay by its pages, and the record beside it', () => {
    const block = {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: {
        type: 'web_fetch_result',
        url: 'https://example.org/sheet.pdf',
        content: {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: sheet.toString('base64') }
        }
      }
    }
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'The GWP is 12 kg CO2-eq.',
        replay: { provider: 'anthropic', model: 'claude-haiku-5-5', steps: [block] },
        record: 'r'.repeat(500)
      }
    ]
    const chars = estimateChars(msgs)
    expect(chars).toBeGreaterThanOrEqual(10 * PDF_PAGE_TOKENS * 4 + 500)
    expect(chars).toBeLessThan(10 * PDF_PAGE_TOKENS * 4 + 2_000)
  })

  it('counts a canvas screenshot at the image ceiling', () => {
    const png = `data:image/png;base64,${randomBytes(600_000).toString('base64')}`
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Canvas screenshot:' },
          { type: 'image_url', image_url: { url: png } }
        ]
      }
    ]
    expect(estimateChars(msgs)).toBeLessThan(IMAGE_TOKENS * 4 + 200)
  })

  it('keeps a turn that starts with a large PDF in its history under the budget it fits', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'file', file: { filename: 's.pdf', file_data: pdfUrl(sheet) } }] },
      { role: 'assistant', content: 'Read it.' },
      { role: 'user', content: 'And the water use?' }
    ]
    const budget = contextBudgetTokens(1_000_000)
    // Counted as text, the file alone was over the budget of a one-million-token window.
    expect(asText / 4).toBeGreaterThan(budget)
    expect(projectTokens(msgs, null)).toBeLessThan(budget / 10)
  })
})
