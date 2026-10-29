import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerMonitor: { isOnBatteryPower: () => false } }))

const { linuxOnMains } = await import('./powerSource')

describe('linuxOnMains', () => {
  it('a laptop with its adapter plugged in is on mains', () => {
    expect(
      linuxOnMains([
        { type: 'Mains', online: '1' },
        { type: 'Battery', online: undefined }
      ])
    ).toBe(true)
  })

  it('a laptop with the adapter out is on battery', () => {
    expect(
      linuxOnMains([
        { type: 'Mains', online: '0' },
        { type: 'Battery', online: undefined }
      ])
    ).toBe(false)
  })

  it('a USB-C supply counts as mains', () => {
    expect(linuxOnMains([{ type: 'USB', online: '1' }, { type: 'Battery' }])).toBe(true)
  })

  it('a desktop has no battery of its own — the wireless mouse battery does not make it a laptop', () => {
    expect(linuxOnMains([])).toBe(true)
    expect(linuxOnMains([{ type: 'Battery', online: '1', scope: 'Device' }])).toBe(true)
  })

  it('a laptop on battery stays on battery while a mouse battery reports itself online', () => {
    expect(
      linuxOnMains([
        { type: 'Mains', online: '0' },
        { type: 'Battery' },
        { type: 'Battery', online: '1', scope: 'Device' }
      ])
    ).toBe(false)
  })

  it('a battery without any adapter reported counts as on battery — when in doubt, sleep', () => {
    expect(linuxOnMains([{ type: 'Battery' }])).toBe(false)
  })
})
