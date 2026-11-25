/**
 * What a file embedded in a message costs a model, in tokens — read from the file itself, because its
 * base64 text says next to nothing about it. A PDF is billed by its pages (each page's text plus an
 * image of the page), an image by its pixels up to a ceiling. Their base64 length divided by four ran
 * 1.3 to 36 times higher on 25 real PDFs: a 10-page data sheet of 3.7 MB is 1.27 million "tokens" as
 * text and about 40,000 as pages. Counted as text, one such file put a conversation over its context
 * budget on its own, and the compaction that followed threw away the very file the user was working with.
 *
 * The files come from three places: attachments (`file` parts and images as data URLs), canvas
 * screenshots (data URLs) and the PDFs a provider opened for the model (Anthropic's `web_fetch`, which
 * hands a PDF back as a base64 document block). contextBudget.ts counts the figures here in their place.
 */
import { inflateSync } from 'node:zlib'

/** Tokens one PDF page costs. Anthropic bills 1,500–3,000 for a page's text and at most 1,568 for its
 *  image: the middle of the one plus the ceiling of the other, rounded up. OpenAI reads a page the same
 *  way and Google for less, so the figure errs to the side that compacts early rather than late. */
export const PDF_PAGE_TOKENS = 4_000

/** Tokens one image costs at most. Anthropic scales every image under 1,568; OpenAI's and Google's
 *  figures for a screenshot-sized image are of the same order. A small image costs less, so the base64
 *  estimate stays where it is lower. */
export const IMAGE_TOKENS = 2_000

/** Strings shorter than this are not looked at: nothing worth a page count is that small. */
const MIN_FILE_CHARS = 4_096

/** A file larger than this is not parsed for its pages — above every provider's request limit
 *  (Anthropic's is 128 MB), so it never reaches a model anyway. */
const MAX_PDF_BYTES = 160 * 1024 * 1024

/**
 * What reading one PDF may cost, all of it on the main process: object streams opened, the bytes they
 * unpack to together, and the time. A fetched PDF comes from any website, and a page count is not worth
 * a decompression bomb or a frozen window. Real files stay far below: across 36 PDFs of 2 to 183 pages,
 * at most 42 streams, 302 KB unpacked and 11 ms. Past any limit the pages are unknown and the file
 * counts as text.
 */
const MAX_OBJECT_STREAMS = 2_000
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
const MAX_PARSE_MS = 250

/** How far an object stream's dictionary may reach around its `/Type /ObjStm`. */
const MAX_DICT_CHARS = 4_096

/** Where a file may sit in a message: an image part's `url`, a file part's `file_data`. */
const FILE_KEYS = new Set(['url', 'file_data'])

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)(?:;[^,;]*)*;base64,/

/** A page object. `/Type /Pages` (a node of the page tree) is not one. */
const PAGE_OBJECT = /\/Type\s*\/Page(?![A-Za-z])/g

/** The first-page dictionary of a linearised ("fast web view") PDF, which states the page count. */
const LINEARIZED = /\/Linearized\b[^>]*?\/N\s+(\d+)/

/** The one encoding of an object stream we unpack: Flate alone, as a name or a one-entry array. */
const FLATE_ONLY = /\/Filter\s*(?:\/FlateDecode\b|\[\s*\/FlateDecode\s*\])/

/** Results by the object that holds the string: the same message is estimated every round. */
const cache = new WeakMap<object, { key: string; chars: number; tokens: number | null }>()

/**
 * Estimated tokens of the file a string in a message holds, or null when it holds none (count it as
 * text). `holder` is the object the string is a property of and `key` that property: a data URL where a
 * message part keeps its file (`image_url.url`, `file.file_data`), or the `data` of a base64 source block
 * (`{type: 'base64', media_type, data}`). Text that merely starts like a data URL stays text — a provider
 * sends it as text and it costs what text costs.
 */
export function embeddedFileTokens(holder: unknown, key: string, value: string): number | null {
  if (value.length < MIN_FILE_CHARS || !holder || typeof holder !== 'object') return null
  const hit = cache.get(holder)
  if (hit && hit.key === key && hit.chars === value.length) return hit.tokens
  const tokens = tokensOf(holder as Record<string, unknown>, key, value)
  cache.set(holder, { key, chars: value.length, tokens })
  return tokens
}

function tokensOf(holder: Record<string, unknown>, key: string, value: string): number | null {
  let mime: string
  let base64: string
  const url = FILE_KEYS.has(key) && value.startsWith('data:') ? DATA_URL.exec(value.slice(0, 256)) : null
  if (url) {
    mime = url[1].toLowerCase()
    base64 = value.slice(url[0].length)
  } else if (key === 'data' && holder.type === 'base64' && typeof holder.media_type === 'string') {
    mime = holder.media_type.toLowerCase()
    base64 = value
  } else {
    return null
  }
  const asText = Math.ceil(base64.length / 4)
  if (mime.startsWith('image/')) return Math.min(asText, IMAGE_TOKENS)
  if (mime === 'application/pdf') {
    const pages = pdfPageCount(Buffer.from(base64, 'base64'))
    // A PDF whose pages cannot be read is counted as before — too high, never too low.
    return pages ? pages * PDF_PAGE_TOKENS : asText
  }
  return null
}

/**
 * The number of pages of a PDF, read from its own structure, or null when it cannot be read in full.
 * The page objects are counted, those in compressed object streams included; a linearised file's stated
 * count can raise the figure, never lower it. Any doubt — an object stream in another encoding, damaged,
 * truncated or over the limits above — makes the answer null rather than a partial count, because a
 * count that is too low lets a conversation run past its window. A file updated in place may still
 * carry an old copy of a page, which is counted too: that error is on the safe side.
 */
export function pdfPageCount(pdf: Buffer): number | null {
  if (pdf.length > MAX_PDF_BYTES) return null
  const text = pdf.toString('latin1')
  if (!text.slice(0, 1024).includes('%PDF-')) return null
  const packed = pagesInObjectStreams(pdf, text)
  if (packed === null) return null
  const stated = Number(LINEARIZED.exec(text.slice(0, 4096))?.[1] ?? 0)
  const pages = Math.max(countPages(text) + packed, stated)
  return pages > 0 ? pages : null
}

/** Page objects inside the file's object streams, or null when one of them cannot be read in full.
 *  One pass over the file: each stream is found from where the previous one ended, and its dictionary
 *  is looked for only within MAX_DICT_CHARS of its type, so no input makes the search quadratic. Every
 *  `/ObjStm` is taken for an object stream — one that turns out not to be makes the count unknown, which
 *  is the safe side. */
function pagesInObjectStreams(pdf: Buffer, text: string): number | null {
  const started = performance.now()
  let pages = 0
  let streams = 0
  let unpacked = 0
  for (let at = text.indexOf('/ObjStm'); at >= 0; at = text.indexOf('/ObjStm', at + 1)) {
    const before = text.slice(Math.max(0, at - MAX_DICT_CHARS), at)
    const open = before.lastIndexOf('<<')
    const keyword = text.slice(at, at + MAX_DICT_CHARS).indexOf('stream')
    if (open < 0 || keyword < 0) return null
    const dict = before.slice(open) + text.slice(at, at + keyword)
    if (!FLATE_ONLY.test(dict) || /\/DecodeParms|\/Predictor/.test(dict)) return null
    let start = at + keyword + 'stream'.length
    if (text[start] === '\r') start++
    if (text[start] === '\n') start++
    const end = text.indexOf('endstream', start)
    if (end < 0) return null
    if (++streams > MAX_OBJECT_STREAMS || performance.now() - started > MAX_PARSE_MS) return null
    try {
      const out = inflateSync(pdf.subarray(start, end), { maxOutputLength: MAX_UNPACKED_BYTES - unpacked })
      unpacked += out.length
      pages += countPages(out.toString('latin1'))
    } catch {
      return null // damaged, encrypted, or past what all streams together may unpack to
    }
    at = end
  }
  return pages
}

const countPages = (text: string): number => text.match(PAGE_OBJECT)?.length ?? 0
