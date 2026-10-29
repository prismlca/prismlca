import { errMsg } from './errors'
import { beginBusy } from './busy'

/**
 * The write-path wrapper five views had each written for themselves: clear the error line, run the
 * mutation, reload and notify — and turn a throw into the error line instead of an unhandled
 * rejection. One shape, so a view cannot forget the reload half (the bug the copies invited).
 */
export function mutationRunner(opts: {
  setError: (msg: string | null) => void
  /** What follows a successful write — typically `load()` then `onChanged?.()`. */
  after?: () => void | Promise<void>
}): (fn: () => Promise<unknown>) => Promise<void> {
  return async (fn) => {
    // The workbench's "Working…" line, for a write that outlives a second (V332).
    const end = beginBusy()
    try {
      opts.setError(null)
      await fn()
      await opts.after?.()
    } catch (e) {
      opts.setError(errMsg(e))
    } finally {
      end()
    }
  }
}
