import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useEChart } from '../lib/charts/useEChart'
import { useThemeKey } from '../lib/charts/useThemeKey'
import { useNearViewport } from '../lib/useNearViewport'
import { deliverDataUrl } from '../lib/download'
import { SaveIcon } from '../components/icons'
import { readChart, type ChartSpec } from './chartSpec'
import { chartHeight, chartOption, laidOut } from './chartOption'

/**
 * How many chart blocks of one answer are drawn. The prompt asks for one; a few leave room for a model
 * that compares two things, and the bound holds for answers no prompt shaped — a stored chat, a chat in
 * someone else's bundle — where a thousand blocks would otherwise be a thousand canvases.
 */
export const CHARTS_PER_ANSWER = 4

/**
 * An `echarts` code block of an assistant's answer, drawn as the chart it describes.
 *
 * What the block may draw is decided in chartSpec.ts (bar and pie, numbers and names only); this
 * component decides what the reader sees: a quiet placeholder while the block is still being streamed,
 * the chart once it is complete, and — for a block that cannot be drawn — the block itself as code, with
 * one line saying why. A chart that throws inside ECharts falls back the same way: chats are stored and
 * replayed, and there is no error boundary further up, so one bad block must never take the transcript
 * down with it.
 *
 * `index` is the block's place among the answer's charts (remarkChartBlocks.ts); past
 * `CHARTS_PER_ANSWER` a block stays code.
 */
export function ChatChart({
  source,
  pending,
  index
}: {
  source: string
  pending: boolean
  index: number
}): JSX.Element {
  const over = index >= CHARTS_PER_ANSWER
  const read = useMemo(() => (pending || over ? null : readChart(source)), [source, pending, over])
  if (pending) return <div className="chat-chart-pending">Drawing a chart…</div>
  if (over)
    return <ChartAsCode source={source} reason={`an answer draws at most ${CHARTS_PER_ANSWER} charts.`} />
  if (!read?.ok) return <ChartAsCode source={source} reason={read?.reason ?? ''} />
  return (
    <ChartBoundary fallback={<ChartAsCode source={source} reason="the chart could not be drawn." />}>
      <ChartBox spec={read.spec} note={read.note} />
    </ChartBoundary>
  )
}

function ChartAsCode({ source, reason }: { source: string; reason: string }): JSX.Element {
  return (
    <>
      <pre>
        <code className="language-echarts">{source}</code>
      </pre>
      <div className="chat-chart-note">Not drawn as a chart: {reason}</div>
    </>
  )
}

/**
 * The chart's box, which draws the chart only while it is in or near the transcript's view.
 *
 * A canvas is a few megabytes of pixels, and a long chat holds many answers. Out of reach, the box keeps
 * the chart's height, so the transcript neither jumps nor loses its place, and the ECharts instance is
 * disposed. The grow animation plays the first time only: a chart scrolled back into view is simply there.
 */
function ChartBox({ spec: read, note }: { spec: ChartSpec; note?: string }): JSX.Element {
  const spec = useMemo(() => laidOut(read), [read])
  const box = useRef<HTMLDivElement>(null)
  const near = useNearViewport(box)
  const [drawn, setDrawn] = useState(false)
  return (
    <div className="chat-chart" ref={box}>
      {near ? (
        <ChartCanvas spec={spec} animate={!drawn} onDrawn={setDrawn} />
      ) : (
        <div style={{ height: chartHeight(spec) }} />
      )}
      {note ? <div className="chat-chart-note">{note}</div> : null}
    </div>
  )
}

/** The chart's file name for "Save as PNG": its title, reduced to what every file system takes. */
function pngName(spec: ChartSpec): string {
  const slug = spec.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `prism-chart${slug ? `-${slug}` : ''}.png`
}

const REG_ID = 'chat-chart'

function ChartCanvas({
  spec,
  animate,
  onDrawn
}: {
  spec: ChartSpec
  animate: boolean
  onDrawn: (drawn: boolean) => void
}): JSX.Element {
  const themeKey = useThemeKey()
  // One chart per registry: the registry only carries this chart's PNG hook to its own button.
  const registry = useRef(new Map<string, () => string>())
  // `animate` is read when the chart is built and is no reason to build it again.
  const ref = useEChart(REG_ID, registry, (el) => chartOption(spec, el, animate), [spec, themeKey])
  useEffect(() => onDrawn(true), [onDrawn])
  const label = spec.title || (spec.kind === 'pie' ? 'Pie chart' : 'Bar chart')
  // A plain box, not a <figure>: a figure takes its accessible name from its caption, and the chart
  // would have been announced as "Save chart as PNG". The name is the canvas', which is the image.
  return (
    <>
      <div
        className="chat-chart-canvas"
        ref={ref}
        role="img"
        aria-label={label}
        style={{ height: chartHeight(spec) }}
      />
      <button
        className="btn sm icon chat-chart-save"
        title="Save chart as PNG"
        aria-label="Save chart as PNG"
        onClick={() => {
          const get = registry.current.get(REG_ID)
          if (get) deliverDataUrl(get(), pngName(spec))
        }}
      >
        <SaveIcon />
      </button>
    </>
  )
}

/** Shows `fallback` instead of a chart that threw while being drawn — in render or in ECharts. */
class ChartBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
