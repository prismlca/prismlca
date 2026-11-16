import type { CanvasResult } from './useCanvasCalc'

const OUTDATED_TIP =
  'The model has changed since this calculation. Calculate again for the current result and Sankey.'

/**
 * The canvas calculation's result above the canvas: the score, the method and the functional unit — and,
 * once the model has changed under it, that it is outdated (workbench/useCanvasCalc.ts).
 *
 * An outdated score is withdrawn, not only tagged: it is the largest number on the screen, and next to a
 * small tag it still read as the current result. The tag stays in the text, so a screen reader hears
 * "outdated" right after the number.
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
      <b className={stale ? 'rb-outdated' : undefined} title={stale ? OUTDATED_TIP : undefined}>
        {result.total} {result.unit}
      </b>
      {' · '}
      {result.method} · FU: {result.fu}
      <span className="rb-meta">
        {result.nodes} nodes · {result.seconds.toFixed(1)} s
      </span>
      {stale ? (
        <span className="rb-stale" title={OUTDATED_TIP}>
          Outdated — recalculate
        </span>
      ) : null}
      <span className="rb-clear" onClick={onClear}>
        clear
      </span>
    </div>
  )
}
