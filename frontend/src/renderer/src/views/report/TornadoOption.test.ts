import { describe, expect, it } from 'vitest'
import { shortTornadoBody, tornadoFromOptions, tornadoIndicators } from './TornadoOption'

describe('the tornado setting', () => {
  it('draws the chosen indicators the report still has, or else the first', () => {
    const choice = { enabled: true, methods: ['a / x', 'gone / y'], delta: 0.1 }
    expect(tornadoIndicators(choice, ['b / z', 'a / x'])).toEqual(['a / x'])
    expect(tornadoIndicators({ ...choice, methods: [] }, ['b / z', 'a / x'])).toEqual(['b / z'])
  })

  it('reads the stored paths as keys, and sends the short report paths', () => {
    expect(tornadoFromOptions({ enabled: true, methods: [['a', 'x']], delta: 0.25 })).toEqual({
      enabled: true,
      methods: ['a / x'],
      delta: 0.25
    })
    expect(tornadoFromOptions(undefined)).toEqual({})
    const chosen = [{ method: ['a', 'x'] }, { method: ['b', 'z'] }]
    expect(
      shortTornadoBody({ tornado: true, tornado_methods: ['b / z'], tornado_delta: 0.5 }, chosen)
    ).toEqual({
      tornado: true,
      tornado_methods: [['b', 'z']],
      tornado_delta: 0.5
    })
    expect(shortTornadoBody({}, chosen)).toEqual({ tornado: false, tornado_methods: [], tornado_delta: 0.1 })
  })
})
