/**
 * The Model page's LCIA method chooser: the catalogue, with the method this model calculates with
 * selected (useCanvasMethod.ts decides which one that is and keeps it).
 *
 * A chosen method the catalogue no longer has stays on display as its own first row, marked as gone,
 * until another is chosen — the chooser never shows a neighbour in its place. While the catalogue is being
 * read again, a chosen method missing from the old list stands there unmarked: it may be in the new one.
 * The rows' values are
 * positions in today's catalogue, read back into the method itself the moment one is picked; nothing
 * keeps a position.
 */
import type { MethodEntry } from '../lib/methods'
import type { CanvasMethod } from './useCanvasMethod'

/** The select's value for the row of a chosen method the catalogue lacks; no catalogue row has it. */
const MISSING = 'missing'

export const goneTitle = (gone: string[]): string =>
  `"${gone.join(' · ')}" is no longer in the method catalogue — it was deleted or renamed. Choose another method to calculate.`

export const checkingTitle = (method: string[]): string =>
  `Reading the method catalogue for "${method.join(' · ')}" …`

export default function CanvasMethodSelect(p: {
  methods: MethodEntry[]
  method: CanvasMethod
  onChoose: (method: string[]) => void
}): JSX.Element {
  const { methods, method } = p
  const missing = method.gone ?? method.checking
  // The full name, because the box is narrower than most of them and the ellipsis eats the indicator —
  // which is the half that distinguishes two rows of the same family.
  const title = method.gone
    ? goneTitle(method.gone)
    : method.checking
      ? checkingTitle(method.checking)
      : method.index >= 0
        ? methods[method.index].name
        : 'LCIA method'
  return (
    <select
      className={method.gone ? 'search-sel method-gone' : 'search-sel'}
      // The title carries the chosen method's full name; the name stays the same whatever is chosen.
      aria-label="LCIA method"
      aria-invalid={method.gone ? true : undefined}
      value={missing ? MISSING : method.index >= 0 ? String(method.index) : ''}
      onChange={(e) => {
        const row = methods[Number(e.target.value)]
        if (e.target.value !== MISSING && row) p.onChoose(row.method)
      }}
      disabled={!methods.length}
      title={title}
    >
      {methods.length ? (
        <>
          {missing ? (
            <option value={MISSING}>
              {method.gone ? `⚠ ${missing.join(' · ')} — no longer available` : missing.join(' · ')}
            </option>
          ) : null}
          {methods.map((m, i) => (
            <option key={i} value={String(i)}>
              {m.recommended ? '★ ' : ''}
              {m.name}
            </option>
          ))}
        </>
      ) : (
        <option>no methods</option>
      )}
    </select>
  )
}
