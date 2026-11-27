/**
 * The release notes the About page shows under "What is new in …". GitHub's release feed carries each
 * release's notes as the HTML GitHub renders from their Markdown, and electron-updater hands that HTML on as
 * it is: one string, or one entry per version. The window never gets the HTML. This module reads the few
 * structures release notes are written in — headings, paragraphs, lists, bold, italics, code and links —
 * into plain data (`ReleaseNotes`, shared/updates.ts), and the page builds its own elements from that data
 * (views/settings/ReleaseNotes.tsx). Every other tag is dropped and its text kept, so nothing in a feed can
 * put markup, scripts or styles into the window.
 */
import type { NoteBlock, NoteSpan, ReleaseNotes } from '../shared/updates'

/** Longer notes are cut after a whole item or paragraph, and the page points to the release page. */
export const MAX_NOTES_CHARS = 8000
/** A list nested deeper than this continues as part of the list it sits in. */
const MAX_LIST_DEPTH = 3
/** Notes are read up to this length. Real ones are a few kilobytes; electron-updater also takes notes from
 *  the update's metadata file as they stand, and parsing runs in the main process. */
const MAX_HTML_CHARS = 200_000

/** Tags whose content is not text a reader should see. */
const HIDDEN = new Set(['script', 'style', 'template', 'svg', 'noscript', 'head', 'title'])
/** Tags that end the paragraph before them and start a new one. */
// prettier-ignore
const BLOCK = new Set([
  'p', 'div', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'details', 'summary',
  'section', 'article', 'header', 'footer', 'hr', 'dl', 'dt', 'dd', 'figure', 'figcaption'
])
/** The entities GitHub's renderer writes; characters beyond them arrive as themselves or as numbers. */
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

/**
 * A comment, a tag (its name and attributes), a run of text, or a `<` that opens nothing. Attributes start
 * after a space or `/` and no part of a tag reaches past the next `<` (GitHub writes `&lt;` in attribute
 * values), so a tag that never closes costs one pass to the next `<`, never a backtracking search.
 */
const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[\s/](?:[^<>"']|"[^"<]*"|'[^'<]*')*)?)>|[^<]+|</g
/** One attribute of a tag: its name and its value, quoted or not. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g

type ListBlock = Extract<NoteBlock, { kind: 'list' }>
/** Where the parser is: the notes themselves or a list item (both hold blocks), or a list between items. */
type Frame = { kind: 'blocks'; blocks: NoteBlock[] } | { kind: 'list'; list: ListBlock }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref.toLowerCase()] ?? whole
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : whole
  })
}

/** The address of an `<a>` — its first `href` attribute, never text inside another attribute's value —
 *  kept only when it is https: anything else stays text. */
function httpsHref(attrs: string): string | undefined {
  for (const m of attrs.matchAll(ATTRIBUTE)) {
    if (m[1].toLowerCase() !== 'href') continue
    const href = decodeEntities((m[2] ?? m[3] ?? m[4] ?? '').trim())
    return /^https:\/\/[^\s/]/i.test(href) ? href : undefined
  }
  return undefined
}

const sameFormat = (a: NoteSpan, b: NoteSpan): boolean =>
  a.strong === b.strong && a.em === b.em && a.code === b.code && a.href === b.href

/** Spans without the space before the first and after the last word, and without empty ones. */
function tidy(spans: NoteSpan[]): NoteSpan[] {
  if (spans.length) {
    spans[0].text = spans[0].text.replace(/^ /, '')
    const last = spans[spans.length - 1]
    last.text = last.text.replace(/ $/, '')
  }
  return spans.filter((s) => s.text !== '')
}

/** Lists and items that ended up with no text in them are dropped. */
function prune(blocks: NoteBlock[]): NoteBlock[] {
  const out: NoteBlock[] = []
  for (const b of blocks) {
    if (b.kind !== 'list') out.push(b)
    else {
      const items = b.items.map(prune).filter((item) => item.length > 0)
      if (items.length) out.push({ ...b, items })
    }
  }
  return out
}

/** One release's notes, from GitHub's HTML into blocks. Whitespace collapses as a browser collapses it;
 *  a `<br>` becomes a space, because GitHub turns every line break of the Markdown into one and the
 *  changelog is wrapped at a fixed width. A `<pre>` keeps its lines and indentation as a code block. */
export function parseNotesHtml(html: string): NoteBlock[] {
  const root: NoteBlock[] = []
  const frames: Frame[] = [{ kind: 'blocks', blocks: root }]
  let spans: NoteSpan[] = []
  /** Whether the text so far ends in a space (or there is none yet). Kept here rather than read off the
   *  last span: asking a string that grows by `+=` for its end flattens it each time, quadratic over a long run. */
  let spaced = true
  let heading = false
  const fmt = { strong: 0, em: 0, code: 0 }
  const links: (string | undefined)[] = []
  let hidden = 0
  let flattened = 0
  /** Inside a `<pre>`: its depth, and its text as written. */
  let pre = 0
  let preText = ''

  const top = (): Frame => frames[frames.length - 1]
  const lists = (): number => frames.filter((f) => f.kind === 'list').length
  const inItem = (): boolean => frames.length > 1 && frames[frames.length - 2].kind === 'list'
  /** The blocks the next block goes into; text between a list's items opens an item of its own. */
  const target = (): NoteBlock[] => {
    const t = top()
    if (t.kind === 'blocks') return t.blocks
    const item: NoteBlock[] = []
    t.list.items.push(item)
    frames.push({ kind: 'blocks', blocks: item })
    return item
  }
  const flush = (): void => {
    const done = tidy(spans)
    const kind = heading ? 'heading' : 'paragraph'
    spans = []
    spaced = true
    heading = false
    if (done.length) target().push({ kind, spans: done })
  }
  const append = (raw: string): void => {
    let text = decodeEntities(raw).replace(/[ \t\n\r\f]+/g, ' ')
    if (spaced && text.startsWith(' ')) text = text.slice(1)
    if (!text) return
    spaced = text.endsWith(' ')
    const last = spans[spans.length - 1]
    const href = links[links.length - 1]
    const span: NoteSpan = {
      text,
      ...(fmt.strong ? { strong: true } : {}),
      ...(fmt.em ? { em: true } : {}),
      ...(fmt.code ? { code: true } : {}),
      ...(href ? { href } : {})
    }
    if (last && sameFormat(last, span)) last.text += text
    else spans.push(span)
  }
  const count = (key: keyof typeof fmt, closing: boolean): void => {
    fmt[key] = Math.max(0, fmt[key] + (closing ? -1 : 1))
  }
  const endPre = (): void => {
    // The line break after `<pre>` is not part of the text, as in a browser; trailing blank lines go too.
    const text = preText.replace(/^\r?\n/, '').replace(/\s+$/, '')
    pre = 0
    preText = ''
    if (text.trim()) target().push({ kind: 'code', text })
  }

  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html
  for (const m of source.matchAll(TOKEN)) {
    const tok = m[0]
    if (tok.startsWith('<!--')) continue
    const name = m[1]?.toLowerCase()
    if (!name) {
      if (hidden) continue
      if (pre) preText += decodeEntities(tok)
      else append(tok)
      continue
    }
    const closing = tok[1] === '/'
    if (HIDDEN.has(name)) {
      if (!tok.endsWith('/>')) hidden = Math.max(0, hidden + (closing ? -1 : 1))
      continue
    }
    if (hidden) continue
    // In a code block only its own end and line breaks count; highlighting spans and the like keep their text.
    if (pre) {
      if (name === 'br') preText += '\n'
      else if (name === 'pre' && !closing) pre++
      else if (name === 'pre' && --pre === 0) endPre()
      continue
    }
    if (name === 'pre') {
      flush()
      if (!closing) pre = 1
    } else if (name === 'br' || name === 'td' || name === 'th') append(' ')
    else if (name === 'strong' || name === 'b') count('strong', closing)
    else if (name === 'em' || name === 'i') count('em', closing)
    else if (name === 'code' || name === 'tt' || name === 'kbd' || name === 'samp') count('code', closing)
    else if (name === 'a') {
      if (closing) links.pop()
      else links.push(httpsHref(m[2] ?? ''))
    } else if (name === 'ul' || name === 'ol') {
      flush()
      if (closing) {
        if (flattened) flattened--
        else if (lists())
          while (frames.length > 1) {
            const f = frames.pop()!
            if (f.kind === 'list') break
          }
      } else if (lists() >= MAX_LIST_DEPTH) flattened++
      else {
        const list: ListBlock = { kind: 'list', ordered: name === 'ol', items: [] }
        target().push(list)
        frames.push({ kind: 'list', list })
      }
    } else if (name === 'li') {
      flush()
      // An open item ends here, whether or not its `</li>` came.
      if (inItem()) frames.pop()
      const t = top()
      if (!closing && t.kind === 'list') {
        const item: NoteBlock[] = []
        t.list.items.push(item)
        frames.push({ kind: 'blocks', blocks: item })
      }
    } else if (/^h[1-6]$/.test(name)) {
      flush()
      heading = !closing
    } else if (BLOCK.has(name)) flush()
  }
  if (pre) endPre()
  flush()
  return prune(root)
}

const textLength = (spans: NoteSpan[]): number => spans.reduce((n, s) => n + s.text.length, 0)
type TextBlock = Exclude<NoteBlock, { kind: 'list' }>
const blockLength = (b: TextBlock): number => (b.kind === 'code' ? b.text.length : textLength(b.spans))

/** The first `n` characters of the spans, with an ellipsis. */
function shorten(spans: NoteSpan[], n: number): NoteSpan[] {
  const out: NoteSpan[] = []
  let left = n
  for (const s of spans) {
    if (left <= 0) break
    out.push(s.text.length <= left ? s : { ...s, text: s.text.slice(0, left).trimEnd() })
    left -= s.text.length
  }
  if (out.length) out[out.length - 1] = { ...out[out.length - 1], text: `${out[out.length - 1].text}…` }
  return out
}

/** The blocks up to `budget` characters of text, cut after a whole paragraph or item. */
export function clipNotes(blocks: NoteBlock[], budget: number): ReleaseNotes {
  let left = budget
  let cut = false
  let read = false
  const walk = (list: NoteBlock[]): NoteBlock[] => {
    const out: NoteBlock[] = []
    for (const b of list) {
      if (cut) break
      if (b.kind === 'list') {
        const items: NoteBlock[][] = []
        for (const item of b.items) {
          if (cut) break
          const kept = walk(item)
          if (kept.length) items.push(kept)
        }
        if (items.length) out.push({ ...b, items })
        continue
      }
      const n = blockLength(b)
      if (n <= left) {
        out.push(b)
        left -= n
        read ||= b.kind !== 'heading'
        continue
      }
      cut = true
      // A first paragraph too long for what is left is shortened, so the page still has a beginning.
      if (!read && left > 0)
        out.push(
          b.kind === 'code'
            ? { ...b, text: `${b.text.slice(0, left).trimEnd()}…` }
            : { ...b, spans: shorten(b.spans, left) }
        )
    }
    return out
  }
  const kept = walk(blocks)
  // A heading whose section was cut away says nothing.
  while (cut && kept.length > 1 && kept[kept.length - 1].kind === 'heading') kept.pop()
  return cut ? { blocks: kept, cut: true } : { blocks: kept }
}

/** The notes electron-updater reports (`releaseNotes`: an HTML string, or `{ version, note }` per version
 *  with `fullChangelog`) as blocks for the About page; undefined when there is nothing to show. */
export function readReleaseNotes(raw: unknown): ReleaseNotes | undefined {
  const blocks: NoteBlock[] = []
  if (typeof raw === 'string') blocks.push(...parseNotesHtml(raw))
  else if (Array.isArray(raw))
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const { version, note } = entry as { version?: unknown; note?: unknown }
      const own = typeof note === 'string' ? parseNotesHtml(note) : []
      if (!own.length) continue
      if (typeof version === 'string' && version)
        blocks.push({ kind: 'heading', spans: [{ text: `Version ${version}` }] })
      blocks.push(...own)
    }
  return blocks.length ? clipNotes(blocks, MAX_NOTES_CHARS) : undefined
}
