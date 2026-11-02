import { processes, type MenuTargets } from './nodeMenuTargets'

export interface CtxMenuState {
  x: number
  y: number
  id: string
  upstream: number
  readOnly: boolean
  /** How many processes are selected — the menu offers to group them, not just this node. */
  selCount: number
  /** What Expand, Collapse, Localize, Remove and Delete act on: the selection's nodes each applies to, or
   *  this node. */
  targets: MenuTargets
  /** The group this node belongs to, or `null`. Membership is a list, never geometry, and a process
   *  belongs to at most one group. */
  groupId: string | null
  /** The box the selection could be added to, when the precondition holds (see `addTarget`). */
  addTo: { id: string; label: string; count: number } | null
}

/** Right-click menu on a canvas node: expand/collapse upstream, group/ungroup, plus — depending on
 * the node — localize/remove (locked reference) or duplicate / move to library / delete (foreground
 * process). Inside a multi-selection, expand, collapse, localize, remove and delete act on every selected
 * node they apply to (see nodeMenuTargets.ts); duplicate and move to library act on this node. */
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
  onExpand: (ids: string[]) => void
  onCollapse: (ids: string[]) => void
  onGroup: () => void
  onAddTo: (groupId: string) => void
  onUngroup: (groupId: string) => void
  onLocalize: (ids: string[]) => void
  onDuplicate: (id: string) => void
  /** Move this process into the library, leaving the model linked to it. */
  onToLibrary: (id: string) => void
  /** Remove (locked) or delete (own) these nodes — one confirm for several. */
  onDelete: (ids: string[]) => void
  onClose: () => void
}): JSX.Element {
  const { expand, collapse, locked, own } = menu.targets
  const many = menu.selCount > 1
  return (
    <div className="node-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {collapse.length ? (
        <button
          onClick={() => {
            onCollapse(collapse)
            onClose()
          }}
        >
          {many ? `Collapse upstream of ${processes(collapse.length)}` : 'Collapse upstream'}
        </button>
      ) : null}
      {expand.length ? (
        <button
          onClick={() => {
            onExpand(expand)
            onClose()
          }}
        >
          {many
            ? `Expand upstream of ${processes(expand.length)}`
            : menu.upstream > 0
              ? `Expand upstream (${menu.upstream})`
              : 'Expand upstream'}
        </button>
      ) : null}
      {!collapse.length && !expand.length ? <button disabled>No hidden upstream</button> : null}
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
              onLocalize(locked)
              onClose()
            }}
            title={
              locked.length > 1
                ? 'Copy each of these processes into the model to edit it there'
                : 'Copy this ecoinvent process into the foreground to edit it'
            }
          >
            {locked.length > 1 ? `Localize ${processes(locked.length)}` : 'Localize (edit)'}
          </button>
          <button
            className="danger"
            onClick={() => {
              onDelete(locked)
              onClose()
            }}
            title={
              locked.length > 1
                ? 'Remove these references from the canvas — the background data stays as it is'
                : 'Remove this reference from the canvas (no data change)'
            }
          >
            {locked.length > 1 ? `Remove ${processes(locked.length)} from canvas` : 'Remove from canvas'}
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
              onDelete(own)
              onClose()
            }}
            title={
              own.length > 1 ? 'Delete these processes from the model' : 'Delete this process from the model'
            }
          >
            {own.length > 1 ? `Delete ${processes(own.length)}` : 'Delete'}
          </button>
        </>
      )}
    </div>
  )
}
