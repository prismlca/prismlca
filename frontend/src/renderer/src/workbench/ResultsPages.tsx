import { useEffect, useState } from 'react'
import type { DatabaseInfo } from '../lib/api'
import type { MethodInfo } from '../views/results/types'
import Results from '../views/Results'
import DetailedResults from '../views/DetailedResults'
import Sensitivity from '../views/sensitivity/Sensitivity'
import type { ResultsTab } from '../views/results/ResultsTabs'

/**
 * The three Results tabs, kept mounted once visited.
 *
 * They live outside the Workbench's view chain: once visited they stay mounted and merely hide, so computed
 * results — and a running sensitivity job — survive a hop to the model page and back. `display: contents`
 * keeps the wrapper out of the layout when visible. The set of visited tabs is reset per model: nothing
 * outlives its model, and at most one result set per tab is ever held.
 */
export function ResultsPages({
  visible,
  tab,
  onTab,
  activeDb,
  methods,
  databases,
  rev,
  searchDbs,
  onSearchDbs,
  onShowDetails
}: {
  /** The Results page is the one on screen. */
  visible: boolean
  tab: ResultsTab
  onTab: (tab: ResultsTab) => void
  activeDb: string | null
  methods: MethodInfo[]
  databases: DatabaseInfo[]
  rev: number
  searchDbs: string[]
  onSearchDbs: (dbs: string[]) => void
  onShowDetails: (target: { database: string; code: string }) => void
}): JSX.Element {
  const [seen, setSeen] = useState<Set<ResultsTab>>(new Set())
  useEffect(() => {
    setSeen(new Set())
  }, [activeDb])
  useEffect(() => {
    if (visible) setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab)))
    // `activeDb` is a dependency ON PURPOSE: the reset above empties the set on a model switch, and
    // without re-adding the tab you are LOOKING AT, switching models while on the Results page
    // unmounted the view and never brought it back — a blank main area until some navigation
    // changed the page. Declared after the reset, so its update lands second.
  }, [visible, tab, activeDb])
  const shown = (t: ResultsTab): React.CSSProperties =>
    visible && tab === t ? { display: 'contents' } : { display: 'none' }

  return (
    <>
      {seen.has('overview') ? (
        <div style={shown('overview')}>
          <Results
            activeDb={activeDb}
            methods={methods}
            databases={databases}
            rev={rev}
            onTab={onTab}
            searchDbs={searchDbs}
            onSearchDbs={onSearchDbs}
          />
        </div>
      ) : null}
      {seen.has('detail') ? (
        <div style={shown('detail')}>
          <DetailedResults
            activeDb={activeDb}
            methods={methods}
            databases={databases}
            rev={rev}
            onShowDetails={onShowDetails}
            onTab={onTab}
            searchDbs={searchDbs}
            onSearchDbs={onSearchDbs}
          />
        </div>
      ) : null}
      {seen.has('sensitivity') ? (
        <div style={shown('sensitivity')}>
          <Sensitivity activeDb={activeDb} methods={methods} rev={rev} onTab={onTab} />
        </div>
      ) : null}
    </>
  )
}
