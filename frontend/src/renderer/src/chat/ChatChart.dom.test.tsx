import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssistantText, Markdown } from './MessageRow'
import { barTooltip, pieTooltip } from './chartOption'
import { CHARTS_PER_ANSWER } from './ChatChart'

// jsdom has no canvas: the chart instance is a recorder. `format` stays ECharts' own, because the
// tooltips encode with it.
const ec = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], disposed: 0, throwOnSet: false }))
vi.mock('echarts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('echarts')>()
  return {
    ...actual,
    init: () => ({
      setOption: (o: Record<string, unknown>) => {
        if (ec.throwOnSet) throw new Error('drawing failed')
        ec.options.push(o)
      },
      getDataURL: () => 'data:image/png;base64,AA',
      resize: () => {},
      dispose: () => {
        ec.disposed++
      },
      on: () => {},
      off: () => {}
    })
  }
})
const delivered = vi.hoisted(() => [] as string[][])
vi.mock('../lib/download', () => ({
  deliverDataUrl: (url: string, name: string) => delivered.push([url, name])
}))

/** An IntersectionObserver the test steers: every box starts in view; `scroll(false)` moves them out. */
const io = vi.hoisted(() => ({
  near: true,
  observers: [] as { cb: (e: { isIntersecting: boolean }[]) => void; els: Element[] }[]
}))
class FakeObserver {
  private entry: (typeof io.observers)[number]
  constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
    this.entry = { cb, els: [] }
    io.observers.push(this.entry)
  }
  observe(el: Element): void {
    this.entry.els.push(el)
    this.entry.cb([{ isIntersecting: io.near }])
  }
  unobserve(): void {}
  disconnect(): void {
    io.observers = io.observers.filter((o) => o !== this.entry)
  }
  takeRecords(): [] {
    return []
  }
}
const scroll = (near: boolean): void =>
  act(() => {
    io.near = near
    for (const o of io.observers) o.cb([{ isIntersecting: near }])
  })

beforeEach(() => {
  ec.options = []
  ec.disposed = 0
  ec.throwOnSet = false
  delivered.length = 0
  io.near = true
  io.observers = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const BLOCK = JSON.stringify({
  title: { text: 'Carbon footprint' },
  xAxis: { data: ['Ingot', 'Recycling credit'] },
  yAxis: { name: 'kg CO2-eq' },
  series: [{ type: 'bar', name: 'GWP100', data: [16.1, -5.7] }]
})
const answer = (block: string, close = true): string =>
  `The frame comes to **10.4 kg CO2-eq**.\n\n\`\`\`echarts\n${block}\n${close ? '```\n\nThat is all.' : ''}`
const noop = (): void => {}

describe('chart blocks in an answer', () => {
  it('draws a stored answer’s block as a chart, from an option of its own', () => {
    const { container } = render(<Markdown text={answer(BLOCK)} onJump={noop} />)
    expect(screen.getByRole('img', { name: 'Carbon footprint' })).toBeTruthy()
    expect(container.querySelector('pre')).toBeNull()
    expect(screen.getByText('That is all.')).toBeTruthy()
    const o = ec.options[0] as {
      series: { type: string; data: { value: number }[] }[]
      tooltip: { formatter: unknown }
    }
    expect(o.series[0].type).toBe('bar')
    expect(o.series[0].data.map((d) => d.value)).toEqual([16.1, -5.7])
    expect(typeof o.tooltip.formatter).toBe('function')
  })

  it('shows a block it cannot draw as code, and says why', () => {
    const line = JSON.stringify({ xAxis: { data: ['a'] }, series: [{ type: 'line', data: [1] }] })
    const { container } = render(<Markdown text={answer(line)} onJump={noop} />)
    expect(container.querySelector('pre code.language-echarts')?.textContent).toBe(line)
    expect(
      screen.getByText(/Not drawn as a chart: only bar and pie charts are drawn here, not "line"\./)
    ).toBeTruthy()
    expect(ec.options).toEqual([])
  })

  it('leaves other code blocks alone', () => {
    const { container } = render(<Markdown text={'```js\nlet a = 1\n```'} onJump={noop} />)
    expect(container.querySelector('pre code.language-js')?.textContent).toBe('let a = 1\n')
  })

  it('holds a placeholder while the block streams in, and draws it once the fence closes', () => {
    const { rerender } = render(<Markdown text={answer(BLOCK.slice(0, 40), false)} onJump={noop} live />)
    expect(screen.getByText('Drawing a chart…')).toBeTruthy()
    rerender(<Markdown text={answer(BLOCK, false)} onJump={noop} live />)
    expect(screen.getByText('Drawing a chart…')).toBeTruthy()
    expect(ec.options).toEqual([])
    rerender(<Markdown text={answer(BLOCK)} onJump={noop} live />)
    expect(screen.getByRole('img', { name: 'Carbon footprint' })).toBeTruthy()
    // Text streaming in after the chart does not draw it again.
    rerender(<Markdown text={`${answer(BLOCK)} More words.`} onJump={noop} live />)
    expect(ec.options).toHaveLength(1)
  })

  it('reads a stored answer whose model never closed the block', () => {
    render(<Markdown text={answer(BLOCK, false)} onJump={noop} />)
    expect(screen.getByRole('img', { name: 'Carbon footprint' })).toBeTruthy()
  })

  it('falls back to the code when drawing throws, keeps the rest of the answer and lets the chart go', () => {
    // React reports the caught error on the console and as a window error; both are expected here.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const quiet = (e: Event): void => e.preventDefault()
    window.addEventListener('error', quiet)
    ec.throwOnSet = true
    const { container } = render(<Markdown text={answer(BLOCK)} onJump={noop} />)
    window.removeEventListener('error', quiet)
    expect(container.querySelector('pre code.language-echarts')?.textContent).toBe(BLOCK)
    expect(screen.getByText(/Not drawn as a chart: the chart could not be drawn\./)).toBeTruthy()
    expect(screen.getByText('That is all.')).toBeTruthy()
    expect(ec.disposed).toBe(1)
  })

  it('disposes the chart with its message', () => {
    const { unmount } = render(<Markdown text={answer(BLOCK)} onJump={noop} />)
    unmount()
    expect(ec.disposed).toBe(1)
  })

  it('saves the chart as a PNG named after its title', async () => {
    render(<Markdown text={answer(BLOCK)} onJump={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Save chart as PNG' }))
    expect(delivered).toEqual([['data:image/png;base64,AA', 'prism-chart-carbon-footprint.png']])
  })

  it('says under a pie with a credit that it was drawn as bars', () => {
    const pie = JSON.stringify({
      series: [
        {
          type: 'pie',
          data: [
            { name: 'Burden', value: 5 },
            { name: 'Credit', value: -2 }
          ]
        }
      ]
    })
    render(<Markdown text={answer(pie)} onJump={noop} />)
    expect(screen.getByText('Drawn as bars: a pie chart cannot show negative values.')).toBeTruthy()
    expect((ec.options[0] as { series: { type: string }[] }).series[0].type).toBe('bar')
  })
})

describe('what a transcript holds', () => {
  it('draws the first few charts of an answer and leaves the rest as code', () => {
    const many = Array.from({ length: CHARTS_PER_ANSWER + 2 }, () => `\`\`\`echarts\n${BLOCK}\n\`\`\``).join(
      '\n\n'
    )
    const { container } = render(<Markdown text={many} onJump={noop} />)
    expect(screen.getAllByRole('img', { name: 'Carbon footprint' })).toHaveLength(CHARTS_PER_ANSWER)
    expect(container.querySelectorAll('pre code.language-echarts')).toHaveLength(2)
    expect(
      screen.getAllByText(`Not drawn as a chart: an answer draws at most ${CHARTS_PER_ANSWER} charts.`)
    ).toHaveLength(2)
  })

  it('keeps the budget across the pieces of an answer that asked questions', () => {
    const four = Array.from({ length: CHARTS_PER_ANSWER }, () => `\`\`\`echarts\n${BLOCK}\n\`\`\``).join(
      '\n\n'
    )
    const text = `${four}\n\n> ❓ Which unit?\n> ➤ kg\n\n${four}`
    render(<AssistantText text={text} onJump={noop} />)
    expect(screen.getAllByRole('img', { name: 'Carbon footprint' })).toHaveLength(CHARTS_PER_ANSWER)
    expect(screen.getAllByText(/an answer draws at most/)).toHaveLength(CHARTS_PER_ANSWER)
  })

  it('draws a block whose language only starts with echarts as a numbered chart, within the budget', () => {
    const odd = Array.from(
      { length: CHARTS_PER_ANSWER + 1 },
      () => `\`\`\`echarts&#32;x\n${BLOCK}\n\`\`\``
    ).join('\n\n')
    render(<Markdown text={odd} onJump={noop} />)
    expect(screen.getAllByRole('img', { name: 'Carbon footprint' })).toHaveLength(CHARTS_PER_ANSWER)
  })

  it('draws a chart only near the view, keeps its height away from it, and animates it once', () => {
    io.near = false
    const { container } = render(<Markdown text={answer(BLOCK)} onJump={noop} />)
    expect(ec.options).toEqual([])
    expect(screen.queryByRole('img')).toBeNull()
    const box = container.querySelector('.chat-chart') as HTMLElement
    expect((box.firstElementChild as HTMLElement).style.height).toMatch(/px$/)
    scroll(true)
    expect(screen.getByRole('img', { name: 'Carbon footprint' })).toBeTruthy()
    expect(ec.options[0].animation).toBe(true)
    scroll(false)
    expect(ec.disposed).toBe(1)
    expect(screen.queryByRole('img')).toBeNull()
    scroll(true)
    expect(ec.options).toHaveLength(2)
    expect(ec.options[1].animation).toBe(false)
  })
})

describe('chart tooltips', () => {
  const evil = '<img src=x onerror="alert(1)">'
  it('encode every name a model wrote', () => {
    const bar = barTooltip([{ axisValueLabel: evil, seriesName: evil, value: 1.23456, marker: '' }])
    const pie = pieTooltip({ seriesName: evil, name: evil, value: 2, percent: 40 })
    for (const html of [bar, pie]) {
      expect(html).not.toContain('<img')
      expect(html).toContain('&lt;img')
    }
    expect(bar).toContain('1.235')
    expect(pie).toContain('(40%)')
  })
})
