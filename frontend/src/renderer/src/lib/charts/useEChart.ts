/**
 * The one ECharts lifecycle for the on-screen charts: init → register the PNG hook → setOption →
 * follow window resizes → dispose. Results.tsx carried this block four times, each copy with the
 * same three subtleties a new copy tends to lose:
 *
 * - the registry binding is captured PER EFFECT RUN, so the cleanup deletes from the same map it
 *   wrote to (a re-render that swaps the registry must not leave a stale PNG hook behind);
 * - the PNG export renders on the app surface colour at 2× — that is what "Save as PNG" ships;
 * - dispose() in the cleanup, or the instance stays in echarts' global registry forever.
 *
 * Deliberately NOT used by the report figures (lib/charts/reportFigures.ts): those render once,
 * off-screen, to SVG, with no resize and no registry — a different lifecycle for a different medium.
 * The radar chart in Results keeps its own two-effect pattern too: it feeds a persistent instance
 * via setOption(notMerge) because init+dispose per data change replays the grow animation — the
 * "it keeps reloading" its comment records. It does share `followBox` below, because the width a
 * chart is drawn at is not a lifecycle question.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import * as echarts from 'echarts'
import { cssVar } from '../cssVar'

/** The per-page map of chart-id → "give me a PNG data-URL", used by the export buttons. */
export type ChartRegistry = { current: Map<string, () => string> }

/**
 * Keep a chart as wide as the box it sits in, for as long as the caller holds the returned stop.
 *
 * Watches the ELEMENT, not the window. A window resize reaches the element anyway, but the reverse
 * does not hold: folding the left rail (11.09.2026) changes every chart's box by 168 px without a
 * window event at all, and a window-only listener left the canvases at their old width — drawn short
 * of the panel, or spilling over the chart beside them once a container breakpoint had moved.
 *
 * Not debounced, unlike the DetailedResults canvas: `resize()` is ECharts' own answer to a changed
 * box and is cheap enough to run per frame, which is what makes the chart follow the fold smoothly
 * instead of snapping to the end of it. The window listener stays as the fallback for an environment
 * without ResizeObserver.
 */
function followBox(el: HTMLElement, chart: echarts.ECharts): () => void {
  const onResize = (): void => chart.resize()
  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }
  const ro = new ResizeObserver(onResize)
  ro.observe(el)
  return () => ro.disconnect()
}

/** What `setOption` accepts — the copies handed their literals straight to it, and `EChartsOption`
 *  is stricter than that (it would refuse the tooltip formatters the charts have always used). */
type SetOptionArg = Parameters<echarts.ECharts['setOption']>[0]

export { followBox }

export function useEChart(
  regId: string,
  registry: ChartRegistry,
  /** Builds the full option; called with the host element so label sizing can read its width. */
  build: (el: HTMLDivElement) => SetOptionArg,
  /** Everything `build` closes over — the effect re-runs exactly when a copy's dependency list did. */
  deps: unknown[]
): MutableRefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    const reg = registry.current // bound per effect run; the cleanup must delete from the same map
    reg.set(regId, () =>
      chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: cssVar('--surface', '#ffffff') })
    )
    chart.setOption(build(ref.current))
    const unfollow = followBox(ref.current, chart)
    return () => {
      unfollow()
      reg.delete(regId)
      chart.dispose()
    }
    // The caller owns the dependency list, exactly as the four inlined copies did — the hook cannot
    // spell out what `build` closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regId, registry, ...deps])
  return ref
}
