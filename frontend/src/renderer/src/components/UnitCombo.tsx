import { useEffect, useRef, useState } from 'react'

/**
 * Editable unit combo for HYBRID mode (free units allowed): an input whose suggestion list
 * opens from the FIRST typed character — native <datalist> popups aren't controllable enough
 * for that. Prefix matches rank before substring matches; picking keeps focus semantics sane
 * (mousedown pick before the input blurs).
 *
 * Also the location field's combo (15.10.2026): `describe` puts a name beside each entry ("DE ·
 * Germany") and is searched too, so "germ" finds DE; `onFocus` lets a caller load its list lazily.
 *
 * It also stands in for every <datalist> whose list can run long (flow properties, CPC classes):
 * Electron draws a datalist's popup itself and that popup does not scroll, so a long vocabulary
 * filled the screen without a scrollbar. This list scrolls past its CSS height, and the arrow keys
 * walk it as they walked the datalist: Enter takes the marked entry like a click, without leaving the field.
 */
export default function UnitCombo({
  value,
  units,
  onChange,
  onCommit,
  onPick,
  autoFocus,
  describe,
  onFocus,
  max = 8,
  ariaLabel,
  placeholder
}: {
  value: string
  units: string[]
  onChange: (v: string) => void
  onCommit?: () => void
  /** A choice from the list, taken at once — a click, or Enter on a typed entry or on the one match
   *  left. Without it a choice only fills the field. */
  onPick?: (u: string) => void
  autoFocus?: boolean
  /** A name shown beside an entry and matched against what is typed. */
  describe?: (u: string) => string | undefined
  onFocus?: () => void
  /** Entries shown at once (the list scrolls past its height anyway). */
  max?: number
  /** The field's name when no visible label sits beside it. */
  ariaLabel?: string
  placeholder?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // The entry the arrow keys have marked; -1 = none, the typed text stands.
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const q = value.trim().toLowerCase()
  const rank = (u: string): number =>
    u.toLowerCase().startsWith(q) ? 0 : (describe?.(u) ?? '').toLowerCase().startsWith(q) ? 1 : 2
  const matches = (
    q
      ? units
          .filter(
            (u) =>
              u !== value && (u.toLowerCase().includes(q) || (describe?.(u) ?? '').toLowerCase().includes(q))
          )
          .sort((a, b) => rank(a) - rank(b))
      : units
  ).slice(0, max)
  const shown = open && matches.length > 0

  useEffect(() => {
    if (active >= 0) listRef.current?.querySelector('.sel')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const close = (): void => {
    setOpen(false)
    setActive(-1)
  }
  const choose = (u: string): void => {
    if (onPick) onPick(u)
    else onChange(u)
    close()
  }

  return (
    <div className="unit-combo">
      <input
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => {
          setOpen(true)
          onFocus?.()
        }}
        // A field that kept its focus after a pick opens again on the next click, not only on typing.
        onClick={() => setOpen(true)}
        onBlur={() => {
          close()
          onCommit?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!shown) {
              setOpen(true)
              setActive(e.key === 'ArrowDown' ? 0 : -1)
            } else
              setActive((i) =>
                e.key === 'ArrowDown' ? Math.min(i + 1, matches.length - 1) : Math.max(i - 1, -1)
              )
            return
          }
          // A marked entry is taken as a click takes it: the field keeps its focus, and with it the
          // commit, which the next Enter or leaving the field makes.
          if (e.key === 'Enter' && shown && matches[active] !== undefined) {
            e.preventDefault()
            choose(matches[active])
            return
          }
          if (e.key === 'Enter' && onPick) {
            const hit =
              units.find((u) => u.toLowerCase() === q) ?? (matches.length === 1 ? matches[0] : undefined)
            if (hit) onPick(hit)
          }
          // An open list takes the first Escape; the dialog around the field (EscapeCloser) the next.
          if (e.key === 'Escape' && shown) e.stopPropagation()
          if (e.key === 'Enter' || e.key === 'Escape') {
            close()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }
        }}
      />
      {shown ? (
        <div className="unit-combo-list" ref={listRef}>
          {matches.map((u, i) => (
            <button
              key={u}
              type="button"
              className={i === active ? 'sel' : undefined}
              // mousedown (not click): fires BEFORE the input's blur, so the pick wins.
              onMouseDown={(e) => {
                e.preventDefault()
                choose(u)
              }}
            >
              {u}
              {describe?.(u) ? (
                <>
                  {' '}
                  <span className="unit-combo-desc">· {describe(u)}</span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
