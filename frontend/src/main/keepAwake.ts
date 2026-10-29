/**
 * Holding off the computer's idle sleep while PrismLCA does long work.
 *
 * An ecoinvent import, a search index, an assistant or report-writer run: each can take an hour, and
 * each is the kind of thing people start and walk away from. Without a hold the computer sleeps after
 * its idle timeout. Local work then waits for a key press; a run that streams from a provider, or an
 * index that embeds over an API, loses its connection — and an index build that fails keeps nothing.
 *
 * The rule, checked every 30 seconds:
 * - hold while the backend reports long work (`/system/busy` → `long_work`) or main has a run going
 *   (ai/activeWork.ts). Requests in flight do not count: an idle window polls too;
 * - let go only after two checks in a row found nothing, so the moment between an import and the
 *   index build it starts does not drop the hold;
 * - never on battery (powerSource.ts), never with the setting off;
 * - a backend that does not answer keeps its last answer for two checks, then counts as idle — a
 *   backend that died is not working for anyone.
 *
 * Holding is Electron's 'prevent-app-suspension': the screen may still turn off. Electron-free, so the
 * rule is testable with fake timers; index.ts wires `powerSaveBlocker` in.
 */

export const KEEP_AWAKE_INTERVAL_MS = 30_000
/** How long one check waits for the backend — apiRequest's own patience is minutes. */
export const KEEP_AWAKE_POLL_TIMEOUT_MS = 10_000
const IDLE_CHECKS_BEFORE_RELEASE = 2
const UNANSWERED_CHECKS_TRUSTED = 2

export interface KeepAwakeDeps {
  /** Start the platform hold; returns its id (powerSaveBlocker.start). */
  hold: () => number
  release: (id: number) => void
  /** The user's switch (Settings → General). */
  enabled: () => boolean
  onMains: () => boolean
  /** The backend's long work, in words for the log; rejects when the backend does not answer. */
  backendWork: () => Promise<string[]>
  /** Main's own long work (ai/activeWork.ts). */
  mainWork: () => string[]
  log?: (msg: string) => void
}

export interface KeepAwake {
  /** Check now, then every interval. */
  start: () => void
  check: () => Promise<void>
  /** At quit: no more checks, and the hold goes. */
  stop: () => void
  held: () => boolean
}

export function createKeepAwake(deps: KeepAwakeDeps): KeepAwake {
  let id: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let checking = false
  let idleChecks = 0
  let unanswered = 0
  let lastBackend: string[] = []

  const hold = (reasons: string[]): void => {
    if (id !== null || stopped) return
    id = deps.hold()
    deps.log?.(`keep-awake on: ${reasons.join(', ')}`)
  }
  const release = (why: string): void => {
    idleChecks = 0
    if (id === null) return
    deps.release(id)
    id = null
    deps.log?.(`keep-awake off: ${why}`)
  }

  // One question at a time: a backend that hangs would otherwise collect a request per check, each
  // waiting out apiRequest's ten minutes. The next check waits on the same one.
  let asking: Promise<string[]> | null = null
  const askBackend = async (): Promise<string[]> => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    asking ??= deps.backendWork().finally(() => {
      asking = null
    })
    try {
      const work = await Promise.race([
        asking,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('no answer')), KEEP_AWAKE_POLL_TIMEOUT_MS)
        })
      ])
      unanswered = 0
      lastBackend = work
      return work
    } catch {
      unanswered++
      return unanswered <= UNANSWERED_CHECKS_TRUSTED ? lastBackend : []
    } finally {
      clearTimeout(deadline)
    }
  }

  const check = async (): Promise<void> => {
    if (checking || stopped) return
    checking = true
    try {
      if (!deps.enabled()) return release('switched off')
      if (!deps.onMains()) return release('on battery')
      const reasons = [...deps.mainWork(), ...(await askBackend())]
      if (reasons.length) {
        idleChecks = 0
        hold(reasons)
      } else if (id !== null && ++idleChecks >= IDLE_CHECKS_BEFORE_RELEASE) {
        release('nothing running')
      }
    } finally {
      checking = false
    }
  }

  const tick = (): void => {
    check().catch((e) => deps.log?.(`keep-awake check failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  return {
    start: () => {
      if (timer || stopped) return
      tick()
      timer = setInterval(tick, KEEP_AWAKE_INTERVAL_MS)
    },
    check,
    stop: () => {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      release('quitting')
    },
    held: () => id !== null
  }
}
