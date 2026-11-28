/**
 * A remark plugin that marks the chart blocks of an answer (fenced code with the language `echarts`) for
 * the chat's `pre` renderer (MessageRow.tsx), with two things the rendered element cannot know itself:
 *
 * - its place among the answer's charts (`data-chart-index`), so the chat draws only the first few
 *   (ChatChart.tsx, `CHARTS_PER_ANSWER`) — a stored or imported answer may hold any number of blocks;
 * - with `live`, while the answer streams in, whether its closing fence has arrived yet
 *   (`data-open-fence`), so a chart still being written is a placeholder and not half a JSON text.
 *
 * Markdown has no notion of an unclosed fence: the parser runs the block to the end of the text and gives
 * it the same `code` node a closed one gets. Only the source tells them apart — the block's last line is a
 * fence of the same character, at least as long as the opening one. A stored answer is final, and a block
 * its model never closed is read for what it holds, so only the streaming text asks.
 *
 * This runs on every chunk of a streaming answer, on text a model wrote. Every check below is linear in
 * the block and looks only at its first and last line.
 */
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface MdNode {
  type: string
  lang?: string | null
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hProperties?: Record<string, unknown> }
  children?: MdNode[]
}

/**
 * Whether a code block's language makes it a chart block — read as mdast-util-to-hast reads it when it
 * writes the `language-…` class the chat's `pre` renderer looks for: the first word. A block typed
 * "```echarts&#32;x" has the language "echarts x" and is drawn, so it is counted too.
 */
export function isChartLang(lang: string | null | undefined): boolean {
  return (lang ?? '').split(/\s+/)[0] === 'echarts'
}

/** The fence a line opens with — ``` or ~~~, three or more — behind any list or quote indentation. */
function fenceOf(line: string): string | null {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '>')) i++
  const mark = line[i]
  if (mark !== '`' && mark !== '~') return null
  let j = i
  while (line[j] === mark) j++
  return j - i >= 3 ? line.slice(i, j) : null
}

/** Whether the raw text of a fenced block ends with a fence that closes it. */
export function fenceClosed(raw: string): boolean {
  const text = raw.trimEnd()
  const firstBreak = text.indexOf('\n')
  if (firstBreak < 0) return false
  const open = fenceOf(text.slice(0, firstBreak))
  const last = text.slice(text.lastIndexOf('\n') + 1)
  const close = fenceOf(last)
  if (!open || !close) return false
  // A closing fence carries nothing after its marks, and matches the opening one in kind and length.
  const after = last.slice(last.indexOf(close) + close.length)
  return close[0] === open[0] && close.length >= open.length && after.trim() === ''
}

export function remarkChartBlocks(options?: { live?: boolean }) {
  const live = options?.live === true
  return (tree: MdNode, file: { toString(): string }): void => {
    const source = live ? String(file) : ''
    let index = 0
    const visit = (node: MdNode): void => {
      if (node.type === 'code' && isChartLang(node.lang)) {
        const props: Record<string, unknown> = { dataChartIndex: index++ }
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (live && start !== undefined && end !== undefined && !fenceClosed(source.slice(start, end)))
          props.dataOpenFence = true
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...props } }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

const counter = unified().use(remarkParse).use(remarkGfm)

/**
 * How many chart blocks a piece of an answer holds, counted as the plugin numbers them. An answer with
 * questions in it is drawn as several Markdown pieces (MessageRow.tsx, `AssistantText`), and each piece
 * numbers its blocks from 0; the pieces before it give the offset that keeps the budget per answer.
 */
export function chartBlockCount(markdown: string): number {
  let n = 0
  const visit = (node: MdNode): void => {
    if (node.type === 'code' && isChartLang(node.lang)) n++
    node.children?.forEach(visit)
  }
  visit(counter.parse(markdown) as unknown as MdNode)
  return n
}
