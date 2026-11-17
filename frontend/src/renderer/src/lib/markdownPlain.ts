/**
 * Markdown read where no Markdown renderer runs: the text a reader sees in the chat, without the
 * marks they would otherwise see as typed — `##`, `**`, `>`, bullets, link syntax, code ticks. One
 * line per block, so the caller decides how to join them.
 *
 * The answer goes through the parser the chat renders it with (react-markdown's remark-parse with
 * remark-gfm), so the excerpt and the chat agree on what is a mark: a `*` that does not render as
 * emphasis (`2 * 3`), a fence that is really a code span, a bracket inside a link's text all come out
 * as the chat shows them.
 */
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse).use(remarkGfm)

type Root = ReturnType<typeof parser.parse>
type Node = Root | Root['children'][number]

interface Line {
  text: string
  heading: boolean
}

/** A heading that already ends in punctuation needs no colon to set it off from what follows. */
const ENDS_IN_PUNCTUATION = /[.,:;!?…]$/

export function plainFromMarkdown(markdown: string): string {
  const lines: Line[] = []
  blocks(parser.parse(markdown), lines)
  // A heading runs straight into the sentence under it once the lines are joined ("Result About
  // 75 kg"), so it is set off with a colon — unless nothing follows it.
  return lines
    .map((l, i) =>
      l.heading &&
      l.text.trim() &&
      !ENDS_IN_PUNCTUATION.test(l.text.trim()) &&
      lines.slice(i + 1).some((n) => n.text.trim())
        ? `${l.text.trimEnd()}:`
        : l.text
    )
    .join('\n')
}

function blocks(node: Node, out: Line[]): void {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
      out.push({ text: inline(node.children), heading: node.type === 'heading' })
      return
    case 'code':
    case 'html': // react-markdown shows raw HTML as the text it is
      out.push({ text: node.value, heading: false })
      return
    case 'table':
      // One line per row, its cells parted by the bar they are typed with. The chat draws as many
      // columns as the delimiter row has, and a cell typed beyond them is not shown, so not quoted.
      for (const row of node.children)
        out.push({
          text: row.children
            .slice(0, node.align ? node.align.length : undefined)
            .map((cell) => inline(cell.children).trim())
            .join(' | '),
          heading: false
        })
      return
    case 'root':
    case 'blockquote':
    case 'list':
    case 'listItem':
      for (const child of node.children) blocks(child, out)
      return
    default:
      // Thematic breaks, link definitions and footnote definitions put no words where a reader starts.
      return
  }
}

/** The words of a run of inline nodes: link text, emphasis without its marks, code as written. */
function inline(nodes: readonly Node[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'inlineCode':
        case 'html':
          return n.value
        case 'break':
          return '\n'
        case 'image':
        case 'imageReference':
          return n.alt ?? ''
        case 'emphasis':
        case 'strong':
        case 'delete':
        case 'link':
        case 'linkReference':
          return inline(n.children)
        default:
          return '' // a footnote reference: a superscript number, nothing to quote
      }
    })
    .join('')
}
