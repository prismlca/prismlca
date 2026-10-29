import type { AttachmentMeta } from '../lib/ai'

/** Whole thousands up to a million, then millions — a chat's prompt side runs into the hundreds of
 *  thousands within a few turns, because the tool list travels with every round. */
export function compact(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** How much of a file went with a turn — pages for a PDF, sheets for a workbook, otherwise size.
 *  The chip above the input disappears the moment the message is sent, so without this the sent
 *  message is the only record and it says nothing: a reader cannot tell an attachment was there. */
export function attachExtent(a: AttachmentMeta): string {
  if (a.pages) return `${a.pages} page${a.pages === 1 ? '' : 's'}`
  if (a.sheets?.length) return `${a.sheets.length} sheet${a.sheets.length === 1 ? '' : 's'}`
  if (a.chars) return `${compact(a.chars)} characters`
  return `${Math.max(1, Math.round(a.bytes / 1024))} kB`
}

/** How full the context is, as a label: a share of the window when the catalogue knows it, else the size. */
export function contextLabel(tokens: number, window?: number): string {
  return window ? `${Math.max(1, Math.round((tokens / window) * 100))}%` : compact(tokens)
}
