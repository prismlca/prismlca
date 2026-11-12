import { useEffect, useId, useRef, useState } from 'react'

/**
 * Editable unit combo for HYBRID mode (free units allowed): an input whose suggestion list
 * opens from the FIRST typed character — native <datalist> popups aren't controllable enough
 * for that. Prefix matches rank before substring matches; picking keeps focus semantics sane
 * (mousedown pick before the input blurs).
 *
 * Also the location field's combo: `describe` puts a name beside each entry ("DE · Germany") and is
 * searched too, so "germ" finds DE; `onFocus` lets a caller load its list lazily. `label` shows an
 * entry under another name than its value (the search's unit filter: "kg" for kilogram), searched too.
 *
 * It also stands in for every <datalist> whose list can run long (flow properties, CPC classes):
 * Electron draws a datalist's popup itself and that popup does not scroll, so a long vocabulary
 * filled the screen without a scrollbar. This list scrolls past its CSS height, and the arrow keys
 * walk it as they walked the datalist: Enter takes the marked entry like a click, without leaving the field.
 *
 * Built as the ARIA 1.2 combobox: the field is the `combobox`, the list a `listbox` of `option`s, and the
 * entry the arrow keys mark is announced through `aria-activedescendant` — the focus stays in the field, so
 * a screen reader hears the suggestion instead of only seeing it highlighted. The options are not tab stops.
 */
export default function UnitCombo({
  value,
  units,
  onChange,
  onCommit,
  onPick,
  autoFocus,
  describe,
  label,
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
  /** What an entry is shown as, if not its value; matched against what is typed as well. */
  label?: (u: string) => string
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
  const listId = useId()
  const optionId = (i: number): string => `${listId}-${i}`
  const q = value.trim().toLowerCase()
  const names = (u: string): string[] => [label?.(u) ?? u, u, describe?.(u) ?? ''].map((n) => n.toLowerCase())
  const rank = (u: string): number => {
    const i = names(u).findIndex((n) => n.startsWith(q))
    return i < 0 ? 3 : i
  }
  const matches = (
    q
      ? units
          .filter((u) => u !== value && names(u).some((n) => n.includes(q)))
          .sort((a, b) => rank(a) - rank(b))
      : units
  ).slice(0, max)
  const shown = open && matches.length > 0
  // The marked entry as it may be used: a list that shrank under the mark (new suggestions arrived, or the
  // caller's list changed) must not leave the field pointing at an option that no longer exists.
  const marked = active < matches.length ? active : -1

  useEffect(() => {
    if (marked >= 0) listRef.current?.querySelector('.sel')?.scrollIntoView?.({ block: 'nearest' })
  }, [marked])

  const close = (): void => {
    setOpen(false)
    setActive(-1)
  }
  // Every way the list opens again in a field that kept its focus after a pick — a click, typing, an arrow
  // key — gives a caller that loads its list on focus the same fresh load a new focus would.
  const reopen = (): void => {
    if (!open) onFocus?.()
    setOpen(true)
  }
  const choose = (u: string): void => {
    if (onPick) onPick(u)
    else onChange(u)
    close()
  }

  return (
    <div className="unit-combo">
      <input
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && marked >= 0 ? optionId(marked) : undefined}
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value)
          reopen()
          setActive(-1)
        }}
        onFocus={() => {
          setOpen(true)
          onFocus?.()
        }}
        // A field that kept its focus after a pick opens again on the next click, not only on typing.
        onClick={reopen}
        onBlur={() => {
          close()
          onCommit?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!shown) {
              reopen()
              setActive(e.key === 'ArrowDown' ? 0 : -1)
            } else
              setActive(
                e.key === 'ArrowDown' ? Math.min(marked + 1, matches.length - 1) : Math.max(marked - 1, -1)
              )
            return
          }
          // A marked entry is taken as a click takes it: the field keeps its focus, and with it the
          // commit, which the next Enter or leaving the field makes.
          if (e.key === 'Enter' && shown && marked >= 0) {
            e.preventDefault()
            choose(matches[marked])
            return
          }
          if (e.key === 'Enter' && onPick) {
            const hit =
              units.find((u) => u.toLowerCase() === q) ??
              units.find((u) => label?.(u).toLowerCase() === q) ??
              (matches.length === 1 ? matches[0] : undefined)
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
        <div
          className="unit-combo-list"
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel ? `${ariaLabel}: suggestions` : 'Suggestions'}
        >
          {matches.map((u, i) => (
            <button
              key={u}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === marked}
              tabIndex={-1}
              className={i === marked ? 'sel' : undefined}
              // mousedown (not click): fires BEFORE the input's blur, so the pick wins.
              onMouseDown={(e) => {
                e.preventDefault()
                choose(u)
              }}
            >
              {label?.(u) ?? u}
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
