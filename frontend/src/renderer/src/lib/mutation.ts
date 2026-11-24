import { errMsg } from './errors'
import { beginBusy } from './busy'

/** A write refused while its dialog is still open (`writeFromDialog`); `mutationRunner` hands it on. */
class DialogRefusal extends Error {
  constructor(readonly reason: unknown) {
    super('refused while its dialog is open')
  }
}

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
      // A dialog's refusal belongs to the dialog: no error line, and no `after` — nothing was written.
      if (e instanceof DialogRefusal) throw e
      opts.setError(errMsg(e))
    } finally {
      end()
    }
  }
}

/**
 * A write started from a dialog. The dialog stays open, with what was typed, until the thing it asked
 * for exists: `write` calls `done()` at that point — right after the creating request, before any
 * follow-up — and returning calls it too. `done` closes the dialog.
 *
 * A throw before `done()` (a taken name, a refused value) comes back as the returned promise's
 * rejection, for the dialog to show in place (components/useDialogSubmit.ts) — at once: the page's
 * error line stays clear of it and the runner's `after` refresh is skipped, as nothing was written. A
 * write that did part of its work before the refusal refreshes for that part itself. A throw after
 * `done()` goes to the page's error line through `run`, like any other write — the dialog is gone.
 */
export function writeFromDialog(
  run: (fn: () => Promise<unknown>) => Promise<void>,
  close: () => void,
  write: (done: () => void) => Promise<unknown>
): Promise<void> {
  let closed = false
  const done = (): void => {
    if (closed) return
    closed = true
    close()
  }
  return run(async () => {
    try {
      await write(done)
    } catch (e) {
      throw closed ? e : new DialogRefusal(e)
    }
    done()
  }).catch((e: unknown) => {
    throw e instanceof DialogRefusal ? e.reason : e
  })
}
