import type { CanvasResult } from './useCanvasCalc'

/**
 * The canvas calculation's result above the canvas: the score, the method and the functional unit — and,
 * once the model has changed under it, that it is outdated (workbench/useCanvasCalc.ts).
 */
export default function ResultBar({
  result,
  stale,
  onClear
}: {
  result: CanvasResult
  stale: boolean
  onClear: () => void
}): JSX.Element {
  return (
    <div className={stale ? 'result-bar stale' : 'result-bar'}>
      <b>
        {result.total} {result.unit}
      </b>
      {' · '}
      {result.method} · FU: {result.fu}
      <span className="rb-meta">
        {result.nodes} nodes · {result.seconds.toFixed(1)} s
      </span>
      {stale ? (
        <span
          className="rb-stale"
          title="The model has changed since this calculation. Calculate again for the current result and Sankey."
        >
          Outdated — recalculate
        </span>
      ) : null}
      <span className="rb-clear" onClick={onClear}>
        clear
      </span>
    </div>
  )
}
