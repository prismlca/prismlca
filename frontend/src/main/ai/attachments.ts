/**
 * Files the user attaches to a chat message: read them here, store them in the project, and turn
 * them into the content parts a model transport understands.
 *
 * Three things live in this file and nowhere else:
 *
 * 1. **The size limits.** Enforced before anything is read into memory or crosses to the backend.
 * 2. **The route each kind takes.** PDFs and images go to the model *natively*, so it sees the
 *    layout, the diagrams and the tables as drawn — for an EPD or a product datasheet that is most
 *    of the information. Everything else is converted to Markdown by the backend, because no chat
 *    endpoint accepts a spreadsheet.
 * 3. **The stub.** Once an attachment has been compacted out of the context, what remains is a line
 *    naming the file and how to open it again. That text is written here so the wording the model
 *    reads and the tool that answers it cannot drift apart.
 *
 * The renderer hands over PATHS, never bytes: an 15 MB PDF through `ipcRenderer.invoke` is a copy
 * in three processes, and main can read the file itself.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import type { AttachmentMeta } from '../../shared/ipc'

/** Files per message. Beyond this the user is not attaching context, they are uploading a folder. */
export const MAX_FILES = 10
/** Raw bytes per message, over all its files. */
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024
export const MAX_PDF_BYTES = 15 * 1024 * 1024
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_SHEET_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_BYTES = 1024 * 1024
/** Anything else (docx, html): the same ceiling as a spreadsheet. */
export const MAX_DOC_BYTES = 20 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

type ApiRequest = (
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
) => Promise<{ status: number; body: unknown }>

function limitFor(name: string): { bytes: number; label: string } {
  const ext = extname(name).toLowerCase()
  if (ext === '.pdf') return { bytes: MAX_PDF_BYTES, label: 'PDF' }
  if (ext in IMAGE_MIME) return { bytes: MAX_IMAGE_BYTES, label: 'image' }
  if (['.xlsx', '.xlsm', '.xltx', '.xltm'].includes(ext))
    return { bytes: MAX_SHEET_BYTES, label: 'spreadsheet' }
  if (['.docx', '.html', '.htm'].includes(ext)) return { bytes: MAX_DOC_BYTES, label: 'document' }
  return { bytes: MAX_TEXT_BYTES, label: 'text file' }
}

/** A size a person and a model can both read. Small files in KB: "0 MB" beside a file that clearly
 *  has content reads as "this is empty", which is the one thing the caption must not say. */
const size = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * Read the given files, store them in the project and describe them.
 *
 * One entry per input path, in order, whether it worked or not: a file that was refused comes back
 * with `error` set rather than being dropped, because silently attaching four of five files is the
 * kind of thing nobody notices until the answer is wrong.
 */
export async function addAttachments(
  paths: string[],
  apiRequest: ApiRequest,
  /** The path main may read for this one, or null to refuse it — `ai:attach` passes the dialog/drop
   *  grants (attachGrants.ts), which answer with the file's resolved real path. Asked before any
   *  read or `stat`; what it returns is what gets read. */
  readablePath: (path: string) => string | null | Promise<string | null> = (p) => p
): Promise<AttachmentMeta[]> {
  const out: AttachmentMeta[] = []
  let budget = MAX_TOTAL_BYTES
  for (const asGiven of paths.slice(0, MAX_FILES)) {
    const name = basename(asGiven)
    const path = await readablePath(asGiven)
    if (!path) {
      out.push({ id: '', name, kind: 'text', bytes: 0, error: NOT_HANDED_OVER })
      continue
    }
    try {
      const info = await stat(path)
      const limit = limitFor(name)
      if (info.size > limit.bytes) {
        out.push({
          id: '',
          name,
          kind: 'text',
          bytes: info.size,
          error: `Too large for a ${limit.label} (${size(info.size)}, limit ${size(limit.bytes)}).`
        })
        continue
      }
      if (info.size > budget) {
        out.push({
          id: '',
          name,
          kind: 'text',
          bytes: info.size,
          error: `Over the ${size(MAX_TOTAL_BYTES)} total for one message.`
        })
        continue
      }
      const data = await readFile(path)
      const { status, body } = await apiRequest('POST', '/api/v1/files/attachments', {
        name,
        data_b64: data.toString('base64')
      })
      if (status >= 400 || !body || typeof body !== 'object') {
        out.push({ id: '', name, kind: 'text', bytes: info.size, error: detailOf(body) })
        continue
      }
      budget -= info.size
      out.push(body as AttachmentMeta)
    } catch (e) {
      out.push({
        id: '',
        name,
        kind: 'text',
        bytes: 0,
        error: e instanceof Error ? e.message : 'Could not read the file.'
      })
    }
  }
  if (paths.length > MAX_FILES) {
    for (const path of paths.slice(MAX_FILES)) {
      out.push({
        id: '',
        name: basename(path),
        kind: 'text',
        bytes: 0,
        error: `More than ${MAX_FILES} files in one message.`
      })
    }
  }
  return out
}

/** What a refused, never-handed-over path says on its chip. It names the two ways that work, because
 *  the only honest way to hit this as a user is a stale path (an earlier pick used up). */
export const NOT_HANDED_OVER =
  'Not attached: PrismLCA only reads files you pick in the file dialog or drop onto the chat, once per ' +
  'pick or drop. Attach the file again that way.'

function detailOf(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  return typeof detail === 'string' && detail ? detail : 'The attachment could not be stored.'
}

/** What the model is told an attachment is, above its content. Also the stub's first line. */
export function heading(meta: AttachmentMeta): string {
  // Pages, sheets or characters where we have them: they say how much there is to read, which bytes
  // do not. Bytes are the fallback for an image or a document we did not count.
  const extent =
    typeof meta.pages === 'number'
      ? `${meta.pages} page${meta.pages === 1 ? '' : 's'}`
      : meta.sheets?.length
        ? `${meta.sheets.length} sheet${meta.sheets.length === 1 ? '' : 's'}`
        : typeof meta.chars === 'number'
          ? `${meta.chars} characters`
          : size(meta.bytes)
  return `${meta.name} (${extent})`
}

/**
 * The line that replaces an attachment once the context is compacted.
 *
 * It has to carry the id, because that is the handle `lookup kind="source"` takes; and it has to say
 * that re-opening is possible, because a model that reads "omitted" concludes the information is
 * gone and answers from what it remembers.
 *
 * The wording is the second attempt. The first one ended "asking for the pages or the sheet you need
 * rather than the whole file", and the test model read that as a *condition*: asked what
 * the datasheet said, it called no tool at all, on the grounds that "the instruction forbids reading
 * the whole file without a page number" — and would have answered from a vague memory of "about 2
 * kg". Exactly the failure this stub exists to prevent. An efficiency preference has to be phrased
 * as one, or it reads as a gate.
 */
export function attachmentStub(what: string, id: string): string {
  if (/^image:/i.test(what)) {
    // The text endpoint has nothing to give for a picture, so the stub must not promise a re-read
    // that returns an empty page.
    return (
      `[image set aside to fit the context: ${what} — id "${id}". It cannot be read back as text; ` +
      `if a detail from it is still needed, ask the user to attach it again.]`
    )
  }
  return (
    `[attachment set aside to fit the context: ${what} — id "${id}". ` +
    `It is still stored with the workspace: read it with lookup kind="source", source="${id}". ` +
    `Naming pages or a sheet narrows the read and is cheaper; leaving them out reads all of it. ` +
    `Do not answer questions about this file from memory.]`
  )
}

/**
 * The caption that travels beside every attachment, in both shapes it takes.
 *
 * Compaction reads the file back out of this line rather than being handed the attachment list: the
 * transcript is the only thing that survives into a later turn, and a second source for "which files
 * are in this conversation" would be one more thing to keep in step. Kept next to the two writers
 * below so the format cannot be changed in one place only.
 */
const CAPTION_RE = /^\[attached file: (.+?) — id "([^"]+)"\]$/
const INLINE_RE = /^--- attached file: (.+?) — id "([^"]+)" ---$/

/** The stub for an attachment part, or null if this text is not one of our captions. */
export function stubForPartText(text: string): string | null {
  const first = text.split('\n', 1)[0]
  const hit = CAPTION_RE.exec(first) ?? INLINE_RE.exec(first)
  return hit ? attachmentStub(hit[1], hit[2]) : null
}

/**
 * Turn stored attachments into the content parts that ride along with the user's message.
 *
 * `vision` is the active model's flag: without it an image part is a 400 from the provider, so a
 * model that cannot see gets told what it was sent instead of the picture.
 */
export async function attachmentParts(
  metas: AttachmentMeta[],
  apiRequest: ApiRequest,
  opts: { vision: boolean }
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = []
  for (const meta of metas) {
    if (!meta.id || meta.error) continue
    if (meta.kind === 'image' && !opts.vision) {
      parts.push({
        type: 'text',
        text: `[image attached: ${heading(meta)} — the active model cannot see images, so it was not sent.]`
      })
      continue
    }
    if (meta.kind === 'image' || meta.kind === 'pdf') {
      const { status, body } = await apiRequest(
        'GET',
        `/api/v1/files/attachments/${encodeURIComponent(meta.id)}/raw`
      )
      const b64 = (body as { data_b64?: string } | null)?.data_b64
      if (status >= 400 || !b64) {
        parts.push({ type: 'text', text: `[attachment ${meta.name} could not be read: ${detailOf(body)}]` })
        continue
      }
      if (meta.kind === 'image') {
        const mime = IMAGE_MIME[extname(meta.name).toLowerCase()] ?? 'image/png'
        parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } })
      } else {
        // The shape both transports understand as "a file": OpenRouter passes it to models that read
        // PDFs natively and parses it for the rest; the Responses API mapping turns it into
        // `input_file` (see providers/openai.ts).
        parts.push({
          type: 'file',
          file: { filename: meta.name, file_data: `data:application/pdf;base64,${b64}` }
        })
      }
      // Say what it is next to what it is: a bare data URL gives the model no name to cite, and
      // "the attached PDF" is ambiguous the moment there are two. This caption is also what the
      // compaction is left holding once the bytes are gone — see stubForPartText.
      parts.push({ type: 'text', text: `[attached file: ${heading(meta)} — id "${meta.id}"]` })
      continue
    }
    const { status, body } = await apiRequest(
      'GET',
      `/api/v1/files/attachments/${encodeURIComponent(meta.id)}/text`
    )
    const text = (body as { text?: string } | null)?.text
    if (status >= 400 || typeof text !== 'string') {
      parts.push({ type: 'text', text: `[attachment ${meta.name} could not be read: ${detailOf(body)}]` })
      continue
    }
    const cut = (body as { truncated?: boolean } | null)?.truncated
    parts.push({
      type: 'text',
      text:
        `--- attached file: ${heading(meta)} — id "${meta.id}" ---\n${text}\n` +
        (cut
          ? `--- end of the part that fit; lookup kind="source", source="${meta.id}" with a page range or sheet gets the rest ---`
          : `--- end of file ---`)
    })
  }
  return parts
}
