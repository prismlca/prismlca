import { groupTints } from '../lib/groups'

/**
 * The colour picker for group boxes: the canvas palette, painted in the tint the box will actually
 * get (see `softTint` in `lib/groups.ts`).
 *
 * Its own component because two places need exactly the same row — the Group button in the canvas
 * toolbar and the recolour dot on a selected box — and a second copy of the swatch row is a second
 * place for the preview to stop matching the paint.
 */
export default function TintSwatches({
  dark,
  current,
  onPick
}: {
  dark: boolean
  /** The full-strength palette colour currently in use, if any. */
  current?: string
  onPick: (color: string) => void
}): JSX.Element {
  return (
    <div className="tint-swatches">
      {groupTints(dark).map(({ color, tint, edge }) => (
        <button
          key={color}
          className={`tint-swatch${current === color ? ' on' : ''}`}
          style={{ background: tint, borderColor: edge }}
          title={`Group tint from ${color}`}
          aria-label={`Group tint from ${color}`}
          data-color={color}
          onClick={(e) => {
            e.stopPropagation()
            onPick(color)
          }}
        />
      ))}
    </div>
  )
}
