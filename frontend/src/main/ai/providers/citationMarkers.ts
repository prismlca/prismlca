/**
 * Removes the inline citation markers OpenAI models write into their text after a web search.
 *
 * A marker is a span between two private-use characters — `U+E200` "cite" `U+E202` "turn0search3"
 * (`U+E202` "turn1view0" …) `U+E201` — that points at a search result by an id only OpenAI's own
 * apps can resolve. The Responses API turns most of them into `url_citation` annotations, but text a
 * model writes between tool calls keeps them raw, and the chat would show them as garbage. Without the
 * search result behind the id there is nothing to link to, so the marker is dropped; the sources reach
 * the chat through the annotations.
 *
 * Text streams in pieces and a marker can be cut anywhere, so a piece from an opening character on
 * is held back until its closing one arrives. Only citation kinds ("cite", "filecite") are removed —
 * other spans are passed on unchanged, and so is a held piece that grows too long to be a marker.
 */

const OPEN = ''
const CLOSE = ''
/** A marker cites a handful of results; beyond this the held text is not a marker. */
const MAX_HELD = 2000
/** The kind word right after the opening character, as far as it has arrived. */
const CITE_SPAN = /^[a-z_]*cite(?:|)/
const CITE_PREFIX = /^[a-z_]*(?:cite(?:[^]*)?)?$/

export class CitationMarkerFilter {
  private held = ''

  /** The part of `piece` that can be shown now; a possibly unfinished marker is kept for later. */
  push(piece: string): string {
    const text = this.held + piece
    this.held = ''
    let out = ''
    let from = 0
    while (from < text.length) {
      const open = text.indexOf(OPEN, from)
      if (open < 0) {
        out += text.slice(from)
        break
      }
      out += text.slice(from, open)
      const close = text.indexOf(CLOSE, open)
      if (close < 0) {
        const rest = text.slice(open)
        if (rest.length > MAX_HELD) out += rest
        else this.held = rest
        break
      }
      const span = text.slice(open, close + 1)
      if (!CITE_SPAN.test(span)) out += span
      from = close + 1
    }
    return out
  }

  /** At the end of a text: what is still held, unless it is the start of a citation marker. */
  flush(): string {
    const rest = this.held
    this.held = ''
    return CITE_PREFIX.test(rest) ? '' : rest
  }
}
