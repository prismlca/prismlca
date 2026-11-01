/**
 * The head of every Results rail: the page name and its three kinds of result.
 *
 * One component for the three views, so a label is renamed once and the tab you are on is marked the
 * same way everywhere. The state stays with the caller (see `ResultsPages`), which also decides which
 * views are mounted.
 */
export type ResultsTab = 'overview' | 'detail' | 'sensitivity'

const TABS: [ResultsTab, string][] = [
  ['overview', 'Results'],
  ['detail', 'Decomposition tree'],
  ['sensitivity', 'Sensitivity analysis']
]

export function ResultsRailHead({
  tab,
  onTab
}: {
  tab: ResultsTab
  onTab?: (tab: ResultsTab) => void
}): JSX.Element {
  return (
    <>
      <div className="panel-h eyebrow">Results</div>
      <div className="rtabs rail-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === tab}
            className={`rtab${id === tab ? ' on' : ''}`}
            onClick={id === tab ? undefined : () => onTab?.(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  )
}
