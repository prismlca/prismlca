/**
 * Which stored chat attachments the OS may open with their default app.
 *
 * A positive list of formats that only get viewed: PDFs, Word documents, spreadsheets without macros,
 * plain text and JSON, CSV and raster images. Every other kind the chat accepts is shown in the file
 * manager instead, and the user decides there what to do with it.
 */
import { basename, extname } from 'node:path'

const VIEW_SAFE = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.xltx',
  '.txt',
  '.log',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp'
])

/** Whether the file at `path` may be opened with its default app — judged by its extension, as the
 *  OS picks that app. */
export function isViewSafe(path: string): boolean {
  return VIEW_SAFE.has(extname(path).toLowerCase())
}

/** Whether `path` is attachment `id`'s own file: a stored attachment is filed under its id, a plain
 *  file name. */
export function isStoredFileOf(path: string, id: string): boolean {
  const name = basename(path)
  return name === id && !name.includes(':')
}

/** What the chat says when a file is shown in its folder instead of opened. Names the file's real
 *  extension, which may differ from the name on the chip. */
export function shownInFolderNote(path: string): string {
  const ext = extname(path).toLowerCase()
  const file = /^\.[a-z0-9]{1,10}$/.test(ext) ? `This ${ext} file` : 'This file'
  return `${file} is shown in its folder rather than opened — PrismLCA opens only documents, spreadsheets, PDFs, plain text and images directly.`
}
