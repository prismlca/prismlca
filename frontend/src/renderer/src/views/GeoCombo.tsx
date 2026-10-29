import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { geoName } from '../../../shared/geographyNames'
import { useGeographyNames } from '../lib/useGeographyNames'
import { type GeoItem, geoLabel as label, groupGeoItems } from './geoComboGroups'

/**
 * Type-to-find geography picker. Options split into two alphabetical groups — aggregations/regions
 * (GLO, RoW, "Europe without Switzerland", …) on top, then countries and sub-countries; `pinned` codes
 * lead the first group (geoComboGroups.ts). Names from the workspace's own release
 * (shared/geographyNames.ts).
 */
export default function GeoCombo({
  items,
  selected,
  placeholder,
  pinned,
  onPick
}: {
  items: GeoItem[]
  selected?: string | null
  placeholder?: string
  pinned?: readonly string[]
  onPick: (value: string) => void
}): JSX.Element {
  const names = useGeographyNames()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  /** The input's box when the list was opened — the list is placed against it, not inside it. */
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number; width: number } | null>(
    null
  )
  /** Where the list actually goes, after it has been measured against the viewport. */
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const openList = (): void => {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setAnchor({ left: r.left, top: r.top, bottom: r.bottom, width: r.width })
    setOpen(true)
    setQ('')
  }

  const ql = q.trim().toLowerCase()
  const match = (it: GeoItem): boolean =>
    !ql || it.geo.toLowerCase().includes(ql) || (geoName(it.geo, names) ?? '').toLowerCase().includes(ql)
  const filtered = items.filter(match)
  const { aggs, countries } = groupGeoItems(filtered, names, pinned)

  /**
   * Where the list goes. Two things had to be fixed here, and both were visible as "the dropdown appears at
   * the bottom right of the screen":
   *
   * 1. It is `position: fixed`, so its coordinates are the viewport's — *unless* an ancestor is a containing
   *    block for fixed descendants. Inside the search dialog one is: `.modal` animates `transform` on open,
   *    and after the animation its computed transform is the identity matrix rather than `none` — an identity
   *    matrix still makes a containing block. So the list was offset by the dialog's own position (451px
   *    across, 78px down in a 1280×820 window) and hung off the right edge. It is drawn in a portal on
   *    `document.body` now, which no transform above it can reach.
   * 2. Nothing clamped it to the window. A row near the bottom put a 280px list below the viewport, and a
   *    wide list on a right-hand row put it past the right edge — so it opens *upwards* when there is no room
   *    below, and its left edge is held inside the window either way.
   *
   * Measured rather than estimated: the list is as tall as its matches, which the typed filter changes.
   */
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const h = listRef.current?.offsetHeight ?? 0
    const w = Math.max(anchor.width, 240)
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8))
    const below = anchor.bottom + 3
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 3) : below
    setPos((prev) =>
      prev && prev.left === left && prev.top === top && prev.width === w ? prev : { left, top, width: w }
    )
  }, [open, anchor, filtered.length])

  const selItem = selected ? items.find((it) => it.value === selected) : undefined
  const display = open ? q : selItem ? label(selItem.geo, names) : ''

  const choose = (it: GeoItem): void => {
    onPick(it.value)
    setOpen(false)
    setQ('')
  }

  const group = (title: string, list: GeoItem[]): JSX.Element | null =>
    list.length ? (
      <>
        <div className="geocombo-grp">{title}</div>
        {list.map((it) => (
          <button
            key={it.value}
            className={it.value === selected ? 'on' : ''}
            onMouseDown={(e) => {
              e.preventDefault()
              choose(it)
            }}
          >
            {label(it.geo, names)}
          </button>
        ))}
      </>
    ) : null

  return (
    <div className="geocombo" ref={ref} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        placeholder={placeholder ?? 'Region…'}
        value={display}
        onFocus={openList}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
      />
      {open && anchor
        ? createPortal(
            <div
              ref={listRef}
              className="geocombo-list"
              // Placed at the anchor for the first frame and corrected in the layout effect above, which runs
              // before paint — so the correction is never visible as a jump.
              style={{
                left: pos?.left ?? anchor.left,
                top: pos?.top ?? anchor.bottom + 3,
                width: pos?.width ?? Math.max(anchor.width, 240)
              }}
              // The portal takes the list out of the combo's subtree, so the outside-click guard cannot see
              // it as "inside" any more: without this a click on an option counted as a click outside and
              // closed the list before the option's own handler ran.
              onMouseDown={(e) => e.stopPropagation()}
            >
              {group('Aggregations / regions', aggs)}
              {group('Countries', countries)}
              {!filtered.length ? <div className="geocombo-empty">no match</div> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
