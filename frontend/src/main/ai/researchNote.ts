/**
 * The note a research leg writes next to a component it found no figure for, as the parent
 * conversation gets it: bounded so a handful of notes cannot crowd the context, cut where a reader
 * can see that and how much is missing, and with the addresses it names handed on whole.
 *
 * Such a note is where the leg says what it did find — dimensions, a comparable product, the page
 * that would hold the figure — and the parent reads the part it is given as the whole answer. A cut
 * without a mark in the middle of a word turned "the datasheet is at …" into "the datasheet could
 * not be retrieved".
 */

/** Longest note text handed on. A few of these still cost less context than one search answer. */
export const NOTE_CHARS = 800
/** A note this little over the limit stays whole: the cut would save less than its own mark costs. */
const GRACE_CHARS = 100
/** Addresses handed on per note; a leg names a handful, the cap only stops a runaway listing. */
const MAX_LINKS = 8
/** All addresses of one note together: room for eight long ones, and a bound on a runaway one. */
const LINKS_CHARS = 2000
/** How a cut note points at its addresses; taken back when none of them turns out to be a page. */
const LINKS_HINT = '; the links it names are in see_also'

/** A note with the addresses it names, as an unresolved component carries them. */
export interface NotedLinks {
  /** What the leg did find, cut to a bounded length with a mark when it ran longer. */
  note?: string
  /** The web addresses the whole note names — where the missing figure may be found. */
  see_also?: string[]
  /** How many further addresses the note named that are not listed, when there were too many. */
  see_also_omitted?: number
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * Take the punctuation of the surrounding sentence off the end of a matched address. A closing
 * bracket goes only when the address does not open one itself, so "(see https://a.example/x)" loses
 * its bracket and "https://a.example/wiki/Steel_(alloy)" keeps it.
 */
function trimLink(raw: string): string {
  let url = raw
  for (;;) {
    const last = url[url.length - 1]
    if (!last) return url
    if ('.,;:!?\'"*'.includes(last)) url = url.slice(0, -1)
    else if (CLOSERS[last] && url.split(last).length > url.split(CLOSERS[last]).length) url = url.slice(0, -1)
    else return url
  }
}

/** The web addresses a text names, in order of appearance, each once. */
export function linksIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    const url = trimLink(m[0])
    // Something has to follow the scheme.
    if (/^https?:\/\/[^/]/i.test(url) && !out.includes(url)) out.push(url)
  }
  return out
}

/**
 * Where to end the kept text: after the last sentence that fits, else before the last word that does
 * not, else at the limit. A sentence end is punctuation followed by white space — which an address
 * never contains, so neither boundary can fall inside one. A sentence end in the first half is passed
 * over for the word boundary: keeping under half of what is allowed to end on a full stop loses more
 * than it tidies.
 */
function cutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit + 1)
  let sentence = -1
  for (const m of window.matchAll(/[.!?…]["'”’»)\]]*(?=\s)/g)) sentence = m.index + m[0].length
  if (sentence >= limit / 2) return sentence
  const word = window.search(/\s\S*$/)
  if (word >= limit / 2) return word
  // One unbroken token: cut at the limit, but not between the two halves of a surrogate pair.
  const code = text.charCodeAt(limit - 1)
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
}

/**
 * Bound a leg's note and pull out the addresses it names.
 *
 * `note` is the text up to about `limit` characters; a longer one ends at a sentence or word boundary
 * and says in so many words that it was cut and by how much. `see_also` lists the addresses of the WHOLE
 * note, cut or not, as the leg wrote them — they are what the parent can act on (open the page,
 * restrict a search to the host), and an address is the one part of a note that is worthless when
 * shortened. The list is not bounded here: which addresses are pages, and which of them are handed
 * on, is settled by `settleLinks` once the search engine's record is complete.
 */
export function clipNote(raw: string, limit = NOTE_CHARS): NotedLinks {
  const text = raw.trim()
  if (!text) return {}
  const links = linksIn(text)
  const see_also = links.length ? { see_also: links } : {}
  if (text.length <= limit + GRACE_CHARS) return { note: text, ...see_also }
  const kept = text.slice(0, cutPoint(text, limit)).trimEnd()
  const mark = `[note cut here: ${text.length - kept.length} more characters not shown${links.length ? LINKS_HINT : ''}]`
  return { note: `${kept} … ${mark}`, ...see_also }
}

/**
 * Turn the addresses a note names into the pages the parent is given.
 *
 * `resolve` answers for one written address with the page it stands for, or null when it leads to no
 * page (a provider's citation link the engine never resolved). Only then are the limits applied —
 * several links to one page are one page, and a long link may stand for a short address — so a limit
 * never spends its room on what would not have been handed on anyway. When more pages remain than
 * fit, those whose address the cut removed from the note text come first, and `see_also_omitted`
 * says how many were left out. A cut note that pointed at its addresses stops doing so when none
 * remains.
 */
export function settleLinks<T extends NotedLinks>(entry: T, resolve: (url: string) => string | null): T {
  if (!entry.see_also) return entry
  const written = entry.see_also
  const rest = { ...entry }
  delete rest.see_also
  delete rest.see_also_omitted
  const note = entry.note ?? ''
  const pages: Array<{ url: string; shown: boolean }> = []
  for (const w of written) {
    const url = resolve(w)
    if (url && !pages.some((p) => p.url === url)) pages.push({ url, shown: note.includes(w) })
  }
  if (!pages.length) {
    const hint = `${LINKS_HINT}]`
    return { ...rest, ...(note.endsWith(hint) ? { note: `${note.slice(0, -hint.length)}]` } : {}) }
  }
  // Document order when everything fits; under pressure, what the note text no longer shows first.
  const fits = pages.length <= MAX_LINKS && pages.reduce((n, p) => n + p.url.length, 0) <= LINKS_CHARS
  const order = fits ? pages : [...pages.filter((p) => !p.shown), ...pages.filter((p) => p.shown)]
  const picked: string[] = []
  let room = LINKS_CHARS
  for (const p of order) {
    if (picked.length >= MAX_LINKS || p.url.length > room) continue
    picked.push(p.url)
    room -= p.url.length
  }
  const omitted = pages.length - picked.length
  return {
    ...rest,
    ...(picked.length ? { see_also: picked } : {}),
    ...(omitted ? { see_also_omitted: omitted } : {})
  }
}
