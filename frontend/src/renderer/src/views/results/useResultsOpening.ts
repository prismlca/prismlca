import { useCallback, useEffect, useMemo } from 'react'
import { api, type DatabaseInfo } from '../../lib/api'
import { fetchQuery, useQuery } from '../../lib/server/useQuery'
import { activitiesRoute, scenariosRoute } from '../../lib/server/routes'
import { readLs } from '../../lib/persist'
import { viewLoaded, viewSet, viewSync } from '../../lib/modelView'
import { migrateSubjectKeys } from '../../lib/subjectKey'
import type { Picked } from './types'

type Setter<T> = (next: T | ((prev: T) => T)) => void

/**
 * Everything that keeps a model's stored Results setup in step with the model when the page opens it — moved out of
 * Results.tsx verbatim, in the order the page always had:
 *   1. the opening pre-selection of the reference process (only when the stored view holds no subject selection),
 *   2. the one-time key migration of a section an older build stored (colours and reference to database/code),
 *   3. a never-looked-at model inheriting the indicators last used anywhere — and remembering every change to them,
 *   4. the model's scenario list, the pruning of ticks of scenarios that no longer exist and the baseline repair.
 *
 * What the order fixes is when the effects START — the page calls this hook at the place the effects stood, so their
 * registration order among all the page's effects is unchanged. It does not fix the order in which their asynchronous
 * work FINISHES: each waits for its own answers (the backend's view, the process and scenario lists, the reference)
 * and writes when they are in, reading the live store at that moment (`storedResults`, the view setters). That is
 * deliberate and tested ("opening under races" in Results.dom.test.tsx); the key migration reads subjSel, scenSel and
 * baseline to resolve an old reference, so do not move these effects apart or reorder them without those tests.
 */
export function useResultsOpening({
  activeDb,
  databases,
  setSubjSel,
  picked,
  setPicked,
  setScenarios,
  setScenSel,
  setBaselineOn
}: {
  activeDb: string | null
  databases: DatabaseInfo[]
  setSubjSel: Setter<Record<string, boolean>>
  picked: Picked[]
  setPicked: Setter<Picked[]>
  setScenarios: (rows: { id: string; name: string }[]) => void
  setScenSel: Setter<Record<string, boolean>>
  setBaselineOn: Setter<boolean>
}) {
  /** The stored `results` section as it stands right now — read imperatively so a seeding guard can
   *  consult it without taking the VALUE as a dependency and re-running itself on its own write. */
  const storedResults = useCallback(
    (): Record<string, unknown> =>
      activeDb ? ((viewSync(activeDb).results as Record<string, unknown> | undefined) ?? {}) : {},
    [activeDb]
  )

  // A model opens on its own reference process — the one no other foreground process consumes — and on
  // nothing else. Pre-selecting every process meant comparing a bottle, a label and a shrink film with
  // each other, which is not a comparison anybody asked for; the sub-processes are added deliberately
  // via "+ Add from this model", like activities from another model or from the database.
  useEffect(() => {
    if (!activeDb) return
    // Read the STORE, not the old browser key. Both selections moved into `prism_meta/views.json`
    // (`useViewField` in useSubjectSelection); the guards kept asking localStorage, where nothing writes any more —
    // except `setup_results`, which wrote `prism.ov.subjSel` and nothing else. So the assistant's
    // call silently switched this pre-selection off for good (localStorage survives restarts) while
    // putting no subject in its place: the page then showed "Pick a subject first" for ever.
    // And ask it only once the BACKEND has answered for the view: an empty cache is not an empty
    // view, and a field written while the GET is out wins over the answer — the default replaced the
    // stored choice (same rule as the key migration below).
    let alive = true
    void Promise.all([
      viewLoaded(activeDb),
      api<{ candidates: { code: string }[] }>(
        'GET',
        `/api/v1/model/reference/${encodeURIComponent(activeDb)}`
      )
    ])
      .then(([loaded, r]) => {
        // A view the backend never answered for is unknown, not empty: a default written now would
        // leave with the cache's section and replace the stored one.
        if (!alive || !loaded) return
        if (storedResults().subjSel) return // already chosen — by the user or by the assistant
        const root = r.candidates?.[0]?.code
        if (root) setSubjSel({ [root]: true })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeDb, setSubjSel, storedResults])

  // Keys stored before the subject identity carried the database: a colour or reference of another
  // model's process or a database activity was kept under its bare code, which now means "this model's
  // process". Moved once (the section is marked with `keys`), silently, as soon as the model's
  // processes and scenarios are known and the BACKEND has answered for the view — migrating the cache
  // after a failed or superseded GET would write an old state over the stored one.
  const dbNamesKey = databases.map((d) => d.name).join('\n')
  useEffect(() => {
    if (!activeDb) return
    let alive = true
    void (async () => {
      const [own, scen] = await Promise.all([
        fetchQuery(activitiesRoute(activeDb)),
        fetchQuery(scenariosRoute(activeDb))
      ])
      if (!alive || !(await viewLoaded(activeDb)) || !alive) return
      const next = migrateSubjectKeys(storedResults(), activeDb, {
        codes: own.map((a) => a.code),
        scenarios: scen.map((x) => x.id),
        databases: dbNamesKey ? new Set(dbNamesKey.split('\n')) : null
      })
      if (next) viewSet(activeDb, 'results', next)
    })().catch(() => {})
    return () => {
      alive = false
    }
  }, [activeDb, storedResults, dbNamesKey])

  // Indicators: a model that has never been looked at inherits the set last used, so the choice is
  // made once rather than per model — but it is stored per model from then on.
  useEffect(() => {
    if (!activeDb) return
    // Same dead key, worse effect: `prism.ov.picked` is written by NOBODY, so this guard never held
    // and the inherit-the-last-set seeding ran on every mount — overwriting a model's own indicator
    // choice with whatever was last looked at somewhere else. That is the very thing the per-model
    // store was introduced to stop. Asked after the backend's answer, like the subject above.
    let alive = true
    void viewLoaded(activeDb)
      .then((loaded) => {
        if (!alive || !loaded || storedResults().picked) return
        const last = readLs<Picked[]>('prism.ov.picked.last', [])
        if (last.length) setPicked(last)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeDb, setPicked, storedResults])
  useEffect(() => {
    if (picked.length) localStorage.setItem('prism.ov.picked.last', JSON.stringify(picked))
  }, [picked])

  // Scenarios of the active model (parameter-override sets) — selectable as extra subjects in the rail.
  // Subscription: the Scenarios editor invalidates this key on every write, so the picker here
  // follows without its own refetch wiring. The pruning of persisted selections stays.
  const scenarioRows = useQuery(activeDb ? scenariosRoute(activeDb) : null).data
  // The overrides themselves, not only which scenarios are ticked: an edited override leaves the
  // subject key unchanged and the old scores standing.
  const scenarioOverridesKey = useMemo(
    () =>
      JSON.stringify(
        (scenarioRows ?? []).map((s) => [s.id, (s as { overrides?: unknown }).overrides ?? null])
      ),
    [scenarioRows]
  )
  useEffect(() => {
    if (!activeDb || !scenarioRows) {
      if (!activeDb) setScenarios([])
      return
    }
    setScenarios(scenarioRows)
    // The stored selection is pruned only once the backend has answered for the view (and not at all
    // when it could not): a write while the GET is out leaves after the 400 ms pause with the cache's
    // section, and the backend replaces the section it is sent — the stored subject and indicators
    // were erased that way.
    let alive = true
    void viewLoaded(activeDb)
      .then((loaded) => {
        if (!alive || !loaded) return
        // With the last scenario gone the baseline switch disappears from the rail; a stored "off" would
        // then leave the selected processes with nothing to compute and no way back.
        if (!scenarioRows.length) setBaselineOn(true)
        const ids = new Set(scenarioRows.map((x) => x.id))
        setScenSel((prev) => {
          const next: Record<string, boolean> = {}
          for (const [k, v] of Object.entries(prev)) if (ids.has(k)) next[k] = v
          return next
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeDb, scenarioRows, setScenSel, setBaselineOn, setScenarios])

  return { scenarioRows, scenarioOverridesKey }
}
