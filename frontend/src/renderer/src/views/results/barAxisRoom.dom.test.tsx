import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { IndicatorChart, StackedIndicatorChart } from './charts'
import { ZOOM_SCALE } from './chartUtils'
import type { ChartRegistry } from '../../lib/charts/useEChart'

type Option = { grid: { top: number }; yAxis: { name?: string } }
const options: Option[] = []

// jsdom has no canvas: keep what each chart hands to ECharts and assert on that.
vi.mock('echarts', () => ({
  init: () => ({
    setOption: (o: Option) => options.push(o),
    getDataURL: () => 'data:image/png;base64,fake',
    resize: () => {},
    dispose: () => {},
    on: () => {},
    off: () => {}
  })
}))

beforeEach(() => {
  options.length = 0
})

const registry = (): ChartRegistry => ({ current: new Map() })

function plainBars(values: number[], scale = 1): Option {
  render(
    <IndicatorChart
      subjects={['Garden hose reel set']}
      values={values}
      colors={['#1f77b4']}
      labels={['']}
      showLabel={false}
      unit="disease incidence"
      themeKey="light"
      regId="pm"
      registry={registry()}
      scale={scale}
    />
  )
  return options[options.length - 1]
}

function stack(values: number[], topLabels: string[]): Option {
  render(
    <StackedIndicatorChart
      subjects={['Garden hose reel set']}
      keys={['use', 'production']}
      keyLabels={{}}
      valuesByKey={{ use: values, production: values }}
      topLabels={topLabels}
      unit="disease incidence"
      themeKey="light"
      regId="pm"
      registry={registry()}
    />
  )
  return options[options.length - 1]
}

/**
 * A value axis whose numbers are rescaled names its exponent above the plot (`×1e-7`). That name only
 * shows when the chart leaves room above the plot; plain bars left 10 px, so a particulate-matter score
 * of 2.75e-7 was drawn on an axis that read 0 to 3. The name needs ECharts' 15 px `nameGap` plus its own
 * 10 px line; at 24 px the top of the glyphs is still cut off.
 */
const NAME_ROOM = 15 + 10

describe('room above the bars for the axis exponent', () => {
  it('plain bars keep room for the exponent of a rescaled axis', () => {
    const o = plainBars([2.75e-7])
    expect(o.yAxis.name).toBe('×1e-7')
    expect(o.grid.top).toBeGreaterThan(NAME_ROOM)
  })

  it('plain bars on an unscaled axis stay as compact as before', () => {
    const o = plainBars([8.57])
    expect(o.yAxis.name).toBeUndefined()
    expect(o.grid.top).toBe(10)
  })

  it('the room grows with the type in the enlarge overlay', () => {
    const panel = plainBars([2.75e-7]).grid.top
    expect(plainBars([2.75e-7], ZOOM_SCALE).grid.top).toBe(Math.round(panel * ZOOM_SCALE))
  })

  it('a stacked chart keeps room for the exponent too, with or without totals above it', () => {
    const o = stack([1.2e-7], [''])
    expect(o.yAxis.name).toBe('×1e-7')
    expect(o.grid.top).toBeGreaterThan(NAME_ROOM)
    expect(stack([1.2e-7], ['2.4e-7']).grid.top).toBeGreaterThan(NAME_ROOM)
    expect(stack([3], ['']).grid.top).toBe(10)
  })
})
