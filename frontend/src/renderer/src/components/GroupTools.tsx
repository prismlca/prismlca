/**
 * The leftmost slot of the canvas toolbar: **Group** (and, when the selection fits, **Add to group**)
 * while several processes are selected, **Ungroup** while a group box is selected. Neither state, no
 * button — the slot disappears instead of showing a disabled control, because "you cannot group one
 * process" is not news worth a permanent grey button.
 *
 * **Nothing here asks for a colour any more.** Group used to open a swatch row first, on the theory
 * that the colour was the one thing about a new group the user had to decide. It was not: the colour
 * carries no meaning, the next unused one is always a fine answer, and the question stood between the
 * user and the thing they had asked for. Both routes into a group now take `nextGroupColor`, and the
 * colour is changed afterwards from the dot on the box's own strip — where the box is, rather than in
 * a toolbar three hundred pixels away.
 *
 * The old reason for keeping the picker up here is still true and is why the *popover* is not on the
 * box either: the box is drawn inside React Flow's viewport, so anything parented to it is zoomed with
 * the canvas (unreadable at 0.3×) and, sitting at a negative z-index, could never come out in front of
 * the process cards. The dot reports its screen rectangle and the Workbench opens the picker outside
 * the canvas at that position — see `CanvasGroups`' `onPickColor` and `groupPicker` in `Workbench`.
 */
export default function GroupTools({
  selectedCount,
  groupSelected,
  addTo,
  onGroup,
  onAddTo,
  onUngroup
}: {
  /** Processes currently selected on the canvas. */
  selectedCount: number
  /** Whether a group box is the current selection. */
  groupSelected: boolean
  /** The box the selection could be added to, if the precondition holds (see `addTarget`). */
  addTo: { label: string; count: number } | null
  onGroup: () => void
  onAddTo: () => void
  onUngroup: () => void
}): JSX.Element | null {
  const canGroup = selectedCount > 1
  if (!canGroup && !groupSelected) return null

  return (
    <div className="group-tool">
      {groupSelected ? (
        <button className="btn sm" onClick={onUngroup} title="Remove this box — the processes stay">
          Ungroup
        </button>
      ) : (
        <>
          <button
            className="btn sm"
            onClick={onGroup}
            title={`Draw a box around the ${selectedCount} selected processes`}
          >
            Group
          </button>
          {addTo ? (
            <button
              className="btn sm"
              onClick={onAddTo}
              title={`Put the ${addTo.count} selected process${addTo.count === 1 ? '' : 'es'} that are not in “${addTo.label}” into it`}
            >
              Add to group
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
