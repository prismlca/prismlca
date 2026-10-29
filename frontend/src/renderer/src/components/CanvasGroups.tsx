import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useReactFlow, ViewportPortal, type Node } from '@xyflow/react'

import {
  drawnGroups,
  GROUP_HEADER,
  groupLabel,
  groupZ,
  nodeBoxes,
  softEdge,
  softTint,
  type NodeGroup
} from '../lib/groups'

/**
 * The group boxes: one tinted rectangle per group, drawn behind every process.
 *
 * **Why these are not React Flow nodes.** React Flow's own answer to "a box that contains nodes" is
 * `parentId` + `extent`, which would give dragging-together for free. It would also make every child
 * node's `position` parent-relative — and this canvas stores absolute positions in the model's view
 * (`layout.pos`), lays out with dagre in absolute coordinates, drops new nodes at
 * `screenToFlowPosition`, and hands absolute positions to the minimap. Turning a group into a parent
 * would therefore reinterpret every position already on disk, with nothing in the stored data saying
 * which frame it was written in. So the box is a derived rectangle instead, rendered into
 * `<ViewportPortal>` (same coordinate system, same pan and zoom) at a negative `z-index`, which puts
 * it behind the node layer *and* the edge layer without touching either. The price is this file:
 * dragging the box has to move the members by hand.
 *
 * **Why only the strip takes a click.** The fill is `pointer-events: none`. Inside a group the box
 * covers most of the canvas, so an interactive fill would eat the rubber-band selection, the pane
 * click and right-click-to-add-a-process — all of which people do *inside* a group. The strip along
 * the top is the box: drag it to move the group, double-click it to rename (or right-click for the menu),
 * click its dot to recolour.
 *
 * **Why each box is one z-index and not two.** The fills used to be painted as one pass and the strips
 * as a second, one layer above, so that no strip could hide under another box's tint. With an explicit
 * depth (see `paintOrder`) that workaround becomes the bug it was hiding: a strip crossing into the
 * box in front of it, which showed up in a screenshot. Fill and strip now share their box's z-index,
 * the strip merely drawn after its own fill — so the whole box obeys its depth, and the box in front
 * covers the one behind it including its strip.
 */
export default function CanvasGroups({
  groups,
  nodes,
  selected,
  editing,
  dark,
  onSelect,
  onMove,
  onMoveEnd,
  onContextMenu,
  onPickColor,
  onEdit,
  onRename
}: {
  groups: NodeGroup[]
  nodes: Node[]
  /** The selected box, or `null`. At most one — a box is selected by its own strip, never by a band. */
  selected: string | null
  /** The box whose name is being edited, or `null`. Held by the caller so the group's own context
   *  menu can start an edit too, rather than the strip being the only way in. */
  editing: string | null
  dark: boolean
  onSelect: (id: string | null) => void
  /** Flow-coordinate delta to apply to every member of the group. */
  onMove: (id: string, dx: number, dy: number) => void
  onMoveEnd: (id: string) => void
  /** Only the screen position is needed, so the narrowest shape that both callers satisfy. */
  onContextMenu: (at: { clientX: number; clientY: number }, id: string) => void
  /** The colour dot was clicked; the rect is the dot's own, in screen pixels (see `onPickColor` use). */
  onPickColor: (at: DOMRect, id: string) => void
  onEdit: (id: string | null) => void
  onRename: (id: string, label: string) => void
}): JSX.Element | null {
  const { getZoom } = useReactFlow()

  // The same two functions the Workbench uses to work out which box "bring forward" should move —
  // one source, so the order on screen and the order being restacked cannot disagree.
  const drawn = useMemo(() => drawnGroups(groups, nodeBoxes(nodes)), [groups, nodes])

  if (!drawn.length) return null

  const startDrag = (e: ReactPointerEvent<HTMLElement>, id: string): void => {
    if (e.button !== 0) return
    // The strip sits above the pane: without this React Flow would also start a selection box.
    e.stopPropagation()
    onSelect(id)
    const el = e.currentTarget
    let last = { x: e.clientX, y: e.clientY }
    try {
      // Keeps the drag alive once the cursor leaves the strip. A synthetic pointer-down (a test, a
      // screenshot script) has no live pointer to capture and throws — the drag itself is unaffected.
      el.setPointerCapture(e.pointerId)
    } catch {
      /* no capturable pointer */
    }
    const move = (ev: PointerEvent): void => {
      // Screen pixels are flow units times the zoom — read per event, so a trackpad pinch mid-drag
      // does not make the box run away from the cursor.
      const zoom = getZoom() || 1
      onMove(id, (ev.clientX - last.x) / zoom, (ev.clientY - last.y) / zoom)
      last = { x: ev.clientX, y: ev.clientY }
    }
    const stop = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', stop)
      el.removeEventListener('pointercancel', stop)
      onMoveEnd(id)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', stop)
    el.addEventListener('pointercancel', stop)
  }

  return (
    <ViewportPortal>
      {drawn.map(({ group, rect }, i) => {
        // The whole box — fill and strip — sits on one layer, and the band is entirely below zero so
        // no box can ever come out in front of an arrow or a process (see `groupZ`).
        const z = groupZ(i, drawn.length)
        return (
          <div key={group.id} className="pgroup-box" style={{ zIndex: z }}>
            <div
              className={`pgroup${selected === group.id ? ' sel' : ''}`}
              data-group={group.id}
              style={{
                transform: `translate(${rect.x}px, ${rect.y}px)`,
                width: rect.width,
                height: rect.height,
                background: softTint(group.color, dark),
                borderColor: softEdge(group.color, dark),
                // Behaviour, not decoration, so it lives here and not in the stylesheet: the fill must
                // let a rubber band, a pane click and a right-click through to the canvas underneath.
                pointerEvents: 'none'
              }}
            />
            <GroupStrip
              group={group}
              rect={rect}
              dark={dark}
              selected={selected === group.id}
              editing={editing === group.id}
              onPointerDown={(e) => startDrag(e, group.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onSelect(group.id)
                onContextMenu(e, group.id)
              }}
              onPickColor={(r) => onPickColor(r, group.id)}
              onEdit={onEdit}
              onRename={onRename}
            />
          </div>
        )
      })}
    </ViewportPortal>
  )
}

/**
 * The strip along the top of one box: drag handle, name, colour dot.
 *
 * Its own component because the rename needs local state (the text being typed) that must not live in
 * a map keyed by group id in the parent — the input has to be able to hold a value the group does not
 * have yet, including the empty string, which is exactly the case the fallback name depends on.
 */
function GroupStrip({
  group,
  rect,
  dark,
  selected,
  editing,
  onPointerDown,
  onContextMenu,
  onPickColor,
  onEdit,
  onRename
}: {
  group: NodeGroup
  rect: { x: number; y: number; width: number }
  dark: boolean
  selected: boolean
  editing: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
  onPickColor: (at: DOMRect) => void
  onEdit: (id: string | null) => void
  onRename: (id: string, label: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!editing) return
    // The stored label, not the printed one: "Group of 5" is a fallback, and offering it as the text to
    // edit would turn the fallback into a stored name the moment somebody pressed Enter.
    setDraft(group.label ?? '')
    input.current?.focus()
    input.current?.select()
  }, [editing, group.label])

  const commit = (): void => {
    onRename(group.id, draft)
    onEdit(null)
  }

  return (
    <div
      className={`pgroup-grip${selected ? ' sel' : ''}`}
      data-grip={group.id}
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: rect.width,
        height: GROUP_HEADER,
        background: softEdge(group.color, dark),
        pointerEvents: 'all' // the one part of a box that is not click-through
      }}
      title="Drag to move the whole group · double-click to rename it · right-click to reorder or ungroup it"
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      // Capture, not bubble: React Flow zooms in on a double-click, and its listener sits on the canvas
      // element — between this strip and React's root, where a bubbling handler would run too late to
      // stop it. Stopped here, the double-click never reaches the canvas, from the name, the dot or the
      // field alike; only the strip itself (and the name on it) starts the edit.
      onDoubleClickCapture={(e) => {
        e.stopPropagation()
        if (!editing && !(e.target as HTMLElement).closest('.pgroup-dot')) onEdit(group.id)
      }}
    >
      {editing ? (
        <input
          ref={input}
          className="pgroup-rename"
          value={draft}
          placeholder={`Group of ${group.members.length}`}
          aria-label="Group name"
          // A pointer-down inside the input must not reach the strip, or clicking into the text to fix a
          // typo would start dragging the whole group under the cursor.
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // The canvas listens for keys of its own (and so does the app shell); a name being typed
            // must not also be a shortcut.
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') onEdit(null) // cancel: the stored label is left as it was
          }}
        />
      ) : (
        // The name is plain text on the strip and nothing else. It used to take
        // the pointer-down away from the drag and start an edit on click, which made the box hard to
        // drag: the name sits in the middle of the handle, so the part of the strip you naturally
        // grab was the one part that did not move the group. A double-click renames instead (see the
        // strip's handler) — it moves nothing, so it cannot be mistaken for a drag, and the whole strip
        // stays handle.
        <span className="pgroup-name">{groupLabel(group)}</span>
      )}
      <button
        className="pgroup-dot"
        style={{ background: group.color, borderColor: group.color }}
        title="Change the group's colour"
        aria-label="Change the group's colour"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          // The dot is inside React Flow's viewport, so it is zoomed with the canvas and sits at a
          // negative z-index — a popover parented to it would be unreadable at 0.3× and could never
          // come out in front of the process cards. The dot's *screen* rectangle goes up instead, and
          // the caller opens the picker outside the canvas at that position.
          onPickColor((e.currentTarget as HTMLElement).getBoundingClientRect())
        }}
      />
    </div>
  )
}
