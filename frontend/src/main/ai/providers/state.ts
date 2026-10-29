/**
 * The active provider, as bare module state — deliberately its own file with zero imports.
 *
 * agent.ts, subagent.ts and reportWriter.ts need to know the active provider to resolve their
 * model DEFAULTS (the ids they also book costs under), but they must not pull in client.ts for it:
 * that would drag `electron` (via secrets) into every test that mocks './client' and nothing
 * else. Same mirroring pattern as the ZDR flag: set from the settings store at startup and on every
 * settings write, never read from the renderer at request time.
 */
import type { ProviderId } from './types'

let _active: ProviderId = 'openrouter'

export function setActiveProvider(p: ProviderId): void {
  _active = p
}

export function getActiveProvider(): ProviderId {
  return _active
}
