export interface CtxMenuState {
  x: number
  y: number
  id: string
  upstream: number
  readOnly: boolean
  expanded: boolean
  /** How many processes are selected — the menu offers to group them, not just this node. */
  selCount: number
  /** The group this node belongs to, or `null`. Membership is a list, never geometry, and a process
   *  belongs to at most one group. */
  groupId: string | null
  /** The box the selection could be added to, when the precondition holds (see `addTarget`). */
  addTo: { id: string; label: string; count: number } | null
}

/** Right-click menu on a canvas node: expand/collapse upstream, group/ungroup, plus — depending on
 * the node — localize/remove (locked reference) or duplicate / move to library / delete (foreground
 * process). */
export default function NodeContextMenu({
  menu,
  onExpand,
  onCollapse,
  onGroup,
  onAddTo,
  onUngroup,
  onLocalize,
  onDuplicate,
  onToLibrary,
  onDelete,
  onClose
}: {
  menu: CtxMenuState
  onExpand: (id: string) => void
  onCollapse: (id: string) => void
  onGroup: () => void
  onAddTo: (groupId: string) => void
  onUngroup: (groupId: string) => void
  onLocalize: (id: string) => void
  onDuplicate: (id: string) => void
  /** Move this process into the library, leaving the model linked to it. */
  onToLibrary: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="node-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {menu.expanded ? (
        <button
          onClick={() => {
            onCollapse(menu.id)
            onClose()
          }}
        >
          Collapse upstream
        </button>
      ) : (
        <button
          disabled={menu.upstream === 0}
          onClick={() => {
            onExpand(menu.id)
            onClose()
          }}
        >
          {menu.upstream === 0
            ? 'No hidden upstream'
            : menu.upstream > 0
              ? `Expand upstream (${menu.upstream})`
              : 'Expand upstream'}
        </button>
      )}
      {menu.selCount > 1 ? (
        <button
          onClick={() => {
            onGroup()
            onClose()
          }}
          title="Draw a tinted box around the selected processes (a view aid — no model change)"
        >
          Group selection ({menu.selCount})
        </button>
      ) : null}
      {menu.addTo ? (
        <button
          onClick={() => {
            onAddTo((menu.addTo as { id: string }).id)
            onClose()
          }}
          title="Put the selected processes that are not in that box into it"
        >
          Add to “{menu.addTo.label}” ({menu.addTo.count})
        </button>
      ) : null}
      {menu.groupId ? (
        <button
          onClick={() => {
            onUngroup(menu.groupId as string)
            onClose()
          }}
          title="Remove the box around this process — the processes stay"
        >
          Ungroup
        </button>
      ) : null}
      {menu.readOnly ? (
        <>
          <button
            onClick={() => {
              onLocalize(menu.id)
              onClose()
            }}
            title="Copy this ecoinvent process into the foreground to edit it"
          >
            Localize (edit)
          </button>
          <button
            className="danger"
            onClick={() => {
              onDelete(menu.id)
              onClose()
            }}
            title="Remove this reference from the canvas (no data change)"
          >
            Remove from canvas
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => {
              onDuplicate(menu.id)
              onClose()
            }}
            title="Create a copy of this process in the model"
          >
            Duplicate
          </button>
          {/* The inverse of Localize, and it says what it costs: the process leaves this model.
              What stays is a link, so a correction made in the library reaches every study that
              uses it — which is the reason to do it at all. */}
          <button
            onClick={() => {
              onToLibrary(menu.id)
              onClose()
            }}
            title="Move this process into My processes — this model then links to it, and so can others"
          >
            Move to library
          </button>
          <button
            className="danger"
            onClick={() => {
              onDelete(menu.id)
              onClose()
            }}
            title="Delete this process from the model"
          >
            Delete
          </button>
        </>
      )}
    </div>
  )
}
