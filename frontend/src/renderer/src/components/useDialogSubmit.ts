import { useCallback, useState } from 'react'
import { errMsg } from '../lib/errors'

/**
 * A dialog's side of a submit whose write may be refused: while the write is out the dialog is busy,
 * and a refusal comes back as the dialog's own error line, with the fields as they were. The caller
 * closes the dialog once the write went through (`writeFromDialog` in lib/mutation.ts).
 *
 * `settle` takes whatever the submit handler returned: a plain value means the caller did the work
 * synchronously and there is nothing to wait for.
 */
export function useDialogSubmit(): {
  busy: boolean
  error: string | null
  settle: (result: unknown) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settle = useCallback((result: unknown): void => {
    setError(null)
    if (!(result instanceof Promise)) return
    setBusy(true)
    result.then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false)
        setError(errMsg(e))
      }
    )
  }, [])
  return { busy, error, settle }
}
