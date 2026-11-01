import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

/**
 * Whether anything that moves a stored run's result changed since the run started: an edit of this model, a
 * workspace-wide change, or an edited factor of one of its methods (`POST /calc/sensitivity/changed`, which
 * reads the audit log and the methods' saved factors — both outlive a restart, as the stored run does).
 * Asked again whenever `rev` moves. `changed` is null until answered and when there is no run to ask about;
 * `failed` says the question could not be answered — the card then says so instead of calling the run current.
 */
export function useRunChanged(
  activeDb: string | null,
  startedAt: string | null,
  methods: string[][],
  rev: number
): { changed: boolean | null; failed: boolean } {
  const [changed, setChanged] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const methodsKey = JSON.stringify(methods)
  useEffect(() => {
    setFailed(false)
    if (!activeDb || !startedAt) {
      setChanged(null)
      return
    }
    let alive = true
    void api<{ changed: boolean }>('POST', '/api/v1/calc/sensitivity/changed', {
      database: activeDb,
      methods: JSON.parse(methodsKey) as string[][],
      since: startedAt
    })
      .then((r) => alive && setChanged(r.changed))
      .catch(() => {
        if (!alive) return
        setChanged(null)
        setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [activeDb, startedAt, methodsKey, rev])
  return { changed, failed }
}
