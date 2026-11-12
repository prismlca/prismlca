import { useEffect, useState } from 'react'
import { BusyClock } from './Busy'
import { CheckIcon } from './icons'

/** How long "Renamed" stays after a rename has landed. */
export const RENAMED_SHOWN_MS = 2500

/**
 * The status line under the Model info title while a model is being renamed, and briefly after.
 *
 * A rename moves far more than a name — every process and exchange is rewritten under the new one, and
 * the chats, reports, parameters and the rest of the model's stores follow it — so on a large model it
 * takes long enough to look like a click that did nothing. While `busy`, a spinner with a clock says what
 * is happening; each time `done` changes (a counter the dialog bumps on success), "Renamed" shows for a
 * moment. A refused rename shows neither: the dialog's error line says why.
 */
export default function RenameStatus({ busy, done }: { busy: boolean; done: number }): JSX.Element | null {
  const [justDone, setJustDone] = useState(false)
  useEffect(() => {
    if (!done) return
    setJustDone(true)
    const t = window.setTimeout(() => setJustDone(false), RENAMED_SHOWN_MS)
    return () => window.clearTimeout(t)
  }, [done])
  if (busy)
    return (
      <p className="mi-title-status">
        <BusyClock label="Renaming… moving chats, reports and parameters" />
      </p>
    )
  if (justDone)
    return (
      <p className="mi-title-status done" role="status">
        <CheckIcon /> Renamed
      </p>
    )
  return null
}
