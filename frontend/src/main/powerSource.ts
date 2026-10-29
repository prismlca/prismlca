/**
 * Is this computer running on mains power? Asked by the keep-awake rule (keepAwake.ts), which holds
 * off sleep only while plugged in — a laptop on battery is allowed to sleep, whatever is running.
 *
 * Windows and macOS: Electron's `powerMonitor` knows. Linux: it does not — Chromium's Linux power
 * monitor is a stub that always reports mains — so we read the kernel's power-supply class instead.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { powerMonitor } from 'electron'

const SUPPLY_DIR = '/sys/class/power_supply'

/** One entry of /sys/class/power_supply, as far as the rule needs it. */
export interface PowerSupply {
  /** `Mains`, `Battery`, `USB`, … */
  type: string
  /** `1` while an external supply delivers power; absent on batteries. */
  online?: string
  /** `Device` for the battery of a mouse, keyboard or headset — not the computer's own. */
  scope?: string
}

/**
 * Mains, by the kernel's account: any external supply online, or no battery of the computer's own
 * at all (a desktop). A laptop that reports its battery but no adapter counts as on battery — when
 * in doubt, the computer may sleep.
 */
export function linuxOnMains(supplies: PowerSupply[]): boolean {
  if (supplies.some((s) => s.type !== 'Battery' && s.online === '1')) return true
  return !supplies.some((s) => s.type === 'Battery' && s.scope !== 'Device')
}

function readLinuxSupplies(): PowerSupply[] {
  const field = (dir: string, name: string): string | undefined => {
    try {
      return readFileSync(join(SUPPLY_DIR, dir, name), 'utf8').trim()
    } catch {
      return undefined
    }
  }
  return readdirSync(SUPPLY_DIR).map((dir) => ({
    type: field(dir, 'type') ?? '',
    online: field(dir, 'online'),
    scope: field(dir, 'scope')
  }))
}

export function onMainsPower(): boolean {
  if (process.platform !== 'linux') return !powerMonitor.isOnBatteryPower()
  try {
    return linuxOnMains(readLinuxSupplies())
  } catch {
    return false // the class is unreadable: nothing is known, so nothing is held
  }
}
