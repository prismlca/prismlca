import { useCallback, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { geoName } from '../../../shared/geographyNames'
import { useGeographyNames } from './useGeographyNames'

/**
 * Location suggestions for an own process: every location the workspace uses — the installed databases
 * and the user's own models — so nobody has to guess whether the background writes "DE" or "Germany".
 * The user's own locations come first, each code with its name beside it.
 *
 * Read on `load()`, once per mount, not on every render: the list comes from every database in the
 * workspace. The inspector's location field loads it when first focused; the new-process dialog when it
 * opens, so a location typed into the previous one is already in the list.
 */
export function useLocationSuggestions(): {
  codes: string[]
  describe: (code: string) => string | undefined
  load: () => void
} {
  const [vocab, setVocab] = useState<{ code: string; own: boolean }[]>([])
  const names = useGeographyNames()
  const started = useRef(false)
  const load = useCallback((): void => {
    if (started.current) return
    started.current = true
    void api<{ locations: { code: string; own: boolean }[] }>('GET', '/api/v1/model/location-vocabulary')
      .then((r) => setVocab(r.locations))
      .catch(() => {})
  }, [])
  const codes = useMemo(
    () => [...vocab.filter((l) => l.own), ...vocab.filter((l) => !l.own)].map((l) => l.code),
    [vocab]
  )
  const own = useMemo(() => new Set(vocab.filter((l) => l.own).map((l) => l.code)), [vocab])
  const describe = useCallback(
    (code: string): string | undefined => {
      const name = geoName(code, names)
      if (name) return name === code ? undefined : name
      return own.has(code) ? 'used in your models' : undefined
    },
    [own, names]
  )
  return { codes, describe, load }
}
