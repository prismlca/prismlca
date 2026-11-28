import { describe, expect, it } from 'vitest'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { chartBlockCount, fenceClosed, remarkChartBlocks } from './remarkChartBlocks'

describe('fenceClosed', () => {
  it('knows a closed block from one still streaming in', () => {
    expect(fenceClosed('```echarts\n{"a": 1}\n```')).toBe(true)
    expect(fenceClosed('```echarts\n{"a": 1}\n```\n')).toBe(true)
    expect(fenceClosed('```echarts\n```')).toBe(true)
    expect(fenceClosed('```echarts\n{"a": 1}')).toBe(false)
    expect(fenceClosed('```echarts\n{"a": 1}\n``')).toBe(false)
    expect(fenceClosed('```echarts')).toBe(false)
  })

  it('takes only a fence of the same kind and at least the same length as closing', () => {
    expect(fenceClosed('~~~echarts\n{}\n~~~')).toBe(true)
    expect(fenceClosed('~~~echarts\n{}\n```')).toBe(false)
    expect(fenceClosed('````echarts\n{}\n```')).toBe(false)
    expect(fenceClosed('```echarts\n{}\n`````')).toBe(true)
    // A line that starts with a fence but goes on is the start of something else, not a close.
    expect(fenceClosed('```echarts\n{}\n```js')).toBe(false)
  })

  it('reads blocks inside list items and quotes', () => {
    expect(fenceClosed('```echarts\n   {}\n   ```')).toBe(true)
    expect(fenceClosed('```echarts\n> {}\n> ```')).toBe(true)
    expect(fenceClosed('```echarts\n> {}')).toBe(false)
  })

  it('stays linear on long runs of white space, which it sees on every streamed chunk', () => {
    const spaces = ' '.repeat(200_000)
    const started = performance.now()
    expect(fenceClosed(`\`\`\`echarts\n{"a": "${spaces}x`)).toBe(false)
    expect(fenceClosed(`\`\`\`echarts\n${spaces}\`\`\`${spaces}x`)).toBe(false)
    expect(fenceClosed(`${spaces}\`\`\`echarts\n{}\n${spaces}\`\`\`${spaces}`)).toBe(true)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

/** The hast properties the plugin gave each code block, in document order. */
function marks(markdown: string, live: boolean): Record<string, unknown>[] {
  const processor = unified().use(remarkParse).use(remarkChartBlocks, { live })
  const tree = processor.runSync(processor.parse(markdown), markdown) as unknown as {
    children: { type: string; data?: { hProperties?: Record<string, unknown> } }[]
  }
  return tree.children.filter((n) => n.type === 'code').map((n) => n.data?.hProperties ?? {})
}

describe('remarkChartBlocks', () => {
  it('numbers the chart blocks of an answer and leaves other code alone', () => {
    const md = '```echarts\n{}\n```\n\n```js\nx\n```\n\n```echarts\n{}\n```'
    expect(marks(md, false)).toEqual([{ dataChartIndex: 0 }, {}, { dataChartIndex: 1 }])
  })

  it('marks an open fence only in the streaming text', () => {
    const md = 'Done.\n\n```echarts\n{}\n```\n\n```echarts\n{"ser'
    expect(marks(md, true)).toEqual([{ dataChartIndex: 0 }, { dataChartIndex: 1, dataOpenFence: true }])
    expect(marks(md, false)).toEqual([{ dataChartIndex: 0 }, { dataChartIndex: 1 }])
  })
})

describe('chart languages', () => {
  it('counts and numbers a block by the first word of its language, as it is drawn', () => {
    const md = '```echarts&#32;x\n{}\n```\n\n```e&#99;harts\n{}\n```\n\n```echartsx\n{}\n```'
    expect(marks(md, false)).toEqual([{ dataChartIndex: 0 }, { dataChartIndex: 1 }, {}])
    expect(chartBlockCount(md)).toBe(2)
  })
})
