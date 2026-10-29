import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * State for a list of ids that keeps its array while the content stays the same.
 *
 * For the canvas selection. React Flow reports what is selected from an effect keyed on the callback it
 * is given, and the Workbench hands it an inline one — so the report arrives after every render. A fresh
 * array per report was a new state each time, which rendered again: the Workbench re-rendered without
 * pause while the canvas was open (two thousand renders in half a second, measured in a test). With an
 * unchanged list the state stays as it is, so the loop ends at the first report, and a list that really
 * changed still goes through as before.
 */
export function useIdListState(initial: string[] = []): [string[], Dispatch<SetStateAction<string[]>>] {
  const [ids, setIds] = useState<string[]>(initial)
  const set = useCallback<Dispatch<SetStateAction<string[]>>>((next) => {
    setIds((prev) => {
      const v = typeof next === 'function' ? next(prev) : next
      return v.length === prev.length && v.every((id, i) => id === prev[i]) ? prev : v
    })
  }, [])
  return [ids, set]
}
