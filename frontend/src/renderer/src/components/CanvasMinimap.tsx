import { useCallback, useEffect, useRef, useState } from 'react'
import { MiniMap, useReactFlow, useStore, type XYPosition } from '@xyflow/react'

import {
  ENLARGE_INTENT_MS,
  MINIMAP_SIZE,
  enlargedMinimapSize,
  minimapFlowPoint,
  minimapNodeClass,
  minimapNodeColor,
  parseMinimapViewBox,
  type Size
} from '../lib/minimap'

/**
 * The whole model in miniature, with the on-screen part cut out of a dimming mask.
 *
 * This is React Flow's own `<MiniMap>` rather than a drawing of our own: it reads the viewport
 * straight out of the store, and it renders each node through a separately memoised component that
 * only re-renders when THAT node moves. Panning therefore costs one mask path, not one rect per
 * process — which is the whole question with a few hundred nodes. What we bring is the theme and the
 * interaction policy.
 *
 * Where it sits is decided by the chat dock, not here: it is handed to `CanvasChat` and rendered as
 * the flex child directly above the input pill (see `.canvas-minimap` in index.css).
 *
 * Two things the map is NOT, and deliberately: it does not pan by dragging, and it does not label
 * anything. Both are in the comments below, at the code that decides them.
 */

export default function CanvasMinimap({
  onDropDataset
}: {
  /**
   * A dataset from the search panel, released on the map. `flow` is the point in the MODEL the map
   * was pointing at — see `onDrop` below for why that, and not the canvas point under the cursor.
   */
  onDropDataset?: (event: React.DragEvent, flow: XYPosition) => void
}): JSX.Element {
  const { setCenter, getZoom } = useReactFlow()
  /** The canvas element, from the store — the box the enlarged map must not grow out of. Taken from
   *  the store rather than by walking the DOM so this file needs no knowledge of the page's classes;
   *  it is the same element `screenToFlowPosition` measures against. */
  const stageEl = useStore((s) => s.domNode)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const aimRef = useRef<HTMLDivElement | null>(null)
  /** The enlarged size while enlarged, `null` while resting. Held as one object, not a boolean plus a
   *  computation, so the size React Flow reads off `style` is stable for as long as it applies. */
  const [big, setBig] = useState<Size | null>(null)
  /** Is a dataset being dragged over the map right now? Drives the drop indicator. */
  const [aiming, setAiming] = useState(false)
  const intent = useRef<number | null>(null)
  /**
   * Escape said no. Without this the map grows straight back: shrinking moves the boundary out from
   * under a pointer that has not moved, and the browser re-evaluates hover on the new layout — so
   * the enter that fires is not the user asking again.
   */
  const dismissed = useRef(false)

  const collapse = useCallback((): void => {
    if (intent.current !== null) {
      window.clearTimeout(intent.current)
      intent.current = null
    }
    setBig(null)
  }, [])

  /**
   * Enlarge, but only if the pointer stays. Hover with an intent delay, and not a modifier or a
   * press-and-hold: a modifier has to be learned and would go unused, and holding collides with the
   * gesture the map already has — a press that ends in a release IS the click that re-centres, so
   * press-and-hold would have to take that away to become unambiguous. The delay is what makes plain
   * hover safe (see ENLARGE_INTENT_MS), and leaving collapses it instantly, so a stray enlargement
   * costs one frame.
   */
  const enlargeSoon = useCallback((): void => {
    if (big || dismissed.current || intent.current !== null) return
    intent.current = window.setTimeout(() => {
      intent.current = null
      const wrap = wrapRef.current
      if (!wrap) return
      const anchor = wrap.getBoundingClientRect()
      const size = enlargedMinimapSize((stageEl ?? wrap).getBoundingClientRect(), anchor)
      // A window with no room for a bigger map keeps the small one rather than flashing the same size
      // with a bigger shadow.
      if (size.width > MINIMAP_SIZE.width) setBig(size)
    }, ENLARGE_INTENT_MS)
  }, [big, stageEl])

  useEffect(() => {
    if (!big) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      dismissed.current = true
      collapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [big, collapse])

  /**
   * A click centres the view on the spot clicked; drag and wheel do nothing (`pannable`/`zoomable`
   * stay off), enlarged as well as small. Deliberate, and unchanged by the enlargement: dragging the
   * viewport box is the gesture that goes wrong, because on a trackpad the same physical motion that
   * starts a click ends as a two-pixel drag, and the user would find the canvas moved when they only
   * meant to look. A click, by contrast, is asked for — and the enlarged map makes it more precise,
   * which is the gain the size was for.
   */
  const recentre = useCallback(
    (_event: React.MouseEvent, pos: XYPosition) => {
      setCenter(pos.x, pos.y, { zoom: getZoom(), duration: 200 })
    },
    [setCenter, getZoom]
  )

  /* --- a dataset dropped on the map ------------------------------------------------------------ */

  /** Only our own drag is intercepted; anything else is left to bubble to the dock, which forwards it
   *  to the canvas underneath. `types` is the one thing readable during a drag — `getData` is not. */
  const carriesDataset = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes('application/prism-hit')

  /** The crosshair follows the pointer by direct style, not by state: `dragover` fires on every few
   *  pixels of movement, and a setState per event would re-render the map to move one dot. */
  const aimAt = (clientX: number, clientY: number): void => {
    const wrap = wrapRef.current
    const dot = aimRef.current
    if (!wrap || !dot) return
    const rect = wrap.getBoundingClientRect()
    dot.style.left = `${clientX - rect.left}px`
    dot.style.top = `${clientY - rect.top}px`
  }

  const onDragOver = (event: React.DragEvent): void => {
    if (!carriesDataset(event)) return
    event.preventDefault()
    event.stopPropagation() // the dock's pass-through must not add the same process a second time
    event.dataTransfer.dropEffect = 'copy'
    if (!aiming) setAiming(true)
    aimAt(event.clientX, event.clientY)
    // Resting over the map with a dataset in hand is the same intent as resting over it empty-handed,
    // and the answer is better here: a bigger map is a target you can aim at.
    enlargeSoon()
  }

  const onDragLeave = (event: React.DragEvent): void => {
    // `dragleave` also fires when the drag crosses from the wrapper onto the SVG inside it, which
    // would collapse the map mid-aim. The pointer's own position is the reliable test; `relatedTarget`
    // is not populated for drag events in Chromium.
    const rect = wrapRef.current?.getBoundingClientRect()
    if (
      rect &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    ) {
      return
    }
    setAiming(false)
    collapse()
  }

  /**
   * The map is a picture of the model, so a point on it names a point in the MODEL — and that is
   * where the process goes.
   *
   * The other reading was the canvas pixel the map is covering, i.e. what the drop would have done
   * before the map was there. It loses on its own terms: it puts the new process behind the 208×132
   * widget that just took the drop, so the user sees the same nothing that the lost drop showed them.
   * This reading puts it where they pointed and shows it landing — a new mark appears on the map under
   * the cursor — and it is the reading the map already speaks in the other direction, where a click
   * means "take me to that place in the model". The crosshair during the drag says which pixel is
   * meant before anything is created. The cost is honest: the process may be created off-screen, and
   * the view deliberately does not chase it (the map moved nothing when it was clicked either).
   */
  const onDrop = (event: React.DragEvent): void => {
    if (!carriesDataset(event)) return
    event.preventDefault()
    event.stopPropagation()
    setAiming(false)
    collapse()
    const svg = wrapRef.current?.querySelector('svg.react-flow__minimap-svg')
    const view = parseMinimapViewBox(svg?.getAttribute('viewBox'))
    if (!svg || !view) return
    const flow = minimapFlowPoint({ x: event.clientX, y: event.clientY }, svg.getBoundingClientRect(), view)
    if (flow) onDropDataset?.(event, flow)
  }

  return (
    <div
      ref={wrapRef}
      className={`canvas-minimap-dock${big ? ' big' : ''}${aiming ? ' aiming' : ''}`}
      onPointerEnter={enlargeSoon}
      onPointerLeave={() => {
        dismissed.current = false // leaving is what re-arms Escape's refusal
        // A pointer event cannot arrive while a drag is in progress, so this one proves there is none
        // — which makes it the honest place to clear an indicator left behind by a cancelled drag.
        setAiming(false)
        collapse()
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <MiniMap
        className="canvas-minimap"
        style={big ?? MINIMAP_SIZE}
        pannable={false}
        zoomable={false}
        nodeColor={minimapNodeColor}
        nodeClassName={minimapNodeClass}
        nodeBorderRadius={2}
        nodeStrokeWidth={0}
        maskStrokeWidth={1.5}
        onClick={recentre}
        /* No node labels, at either size, and not for want of room: React Flow draws one <rect> per
           node and one mask path, and a name per node means a <text> per node — text shaping and
           layout for every process on every pan frame, against rects that cost nothing. It would also
           be a false promise, because even enlarged a 210 px card is ~13 px wide here. Bigger marks
           are the honest offer; the names are answered by the click and by search. */
        /* Rendered as the SVG's <title>, so it is both the accessible name and the hover tooltip. */
        ariaLabel="Model map — the outlined rectangle is the part on screen. Click to centre the view there, hold the pointer here to enlarge, or drop a dataset to place it at that point in the model."
      />
      <div className="mm-aim" ref={aimRef} aria-hidden="true" />
      {aiming ? <div className="mm-aim-hint">Drop to place here</div> : null}
    </div>
  )
}
