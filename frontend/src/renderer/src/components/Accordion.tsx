import type { Dispatch, SetStateAction } from 'react'
import { usePersisted } from '../lib/persist'
import { ChevronIcon } from './icons'

/**
 * One collapsible group of a rail's controls.
 *
 * The pattern the Report page introduced and Results now shares: a panel had grown into one long column
 * where a theme picker, a subject selection and a fifteen-chapter list all competed for the same scroll.
 * Collapsed, a group says what it holds — the report's name, how many indicators it covers, which theme —
 * so the summary line often replaces the need to open it at all.
 *
 * Exactly one group is open at a time (see `useSingleOpen`): two of them reintroduce the scroll the
 * accordion exists to remove, and with a long list among them one of the two is always the one you cannot
 * see. Clicking the open group closes it, so all-closed is reachable — that is the state in which the
 * summaries alone answer the question.
 */
export function AccordionGroup({
  title,
  summary,
  open,
  onToggle,
  children
}: {
  title: string
  /** Shown only while closed — open, the group's own controls say it better than a summary can. */
  summary?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className={`acc-grp${open ? ' open' : ''}`}>
      <button className="acc-ghead" onClick={onToggle} aria-expanded={open}>
        <span className="car" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="t">{title}</span>
        {summary && !open ? <span className="s">{summary}</span> : null}
      </button>
      {open ? <div className="acc-gbody">{children}</div> : null}
    </section>
  )
}

/**
 * Which single group of one accordion is open, remembered across visits.
 *
 * Returns `[grp, setOpen]`. `grp(id)` is spread onto a group — `<AccordionGroup {...grp('covers')}>` — and
 * `setOpen` is for the rare case where the page itself knows better than the last click: a report with no
 * indicator has to show the group that is blocking it. Persisted because which panel you leave open is a
 * working habit, not a preference to set, and having them all snap shut on every visit is what made the
 * old collapsible annoying enough to notice.
 */
export function useSingleOpen(
  storageKey: string,
  initial: string
): [(id: string) => { open: boolean; onToggle: () => void }, Dispatch<SetStateAction<string>>] {
  const [openId, setOpenId] = usePersisted<string>(storageKey, initial)
  const grp = (id: string): { open: boolean; onToggle: () => void } => ({
    open: openId === id,
    onToggle: () => setOpenId(openId === id ? '' : id)
  })
  return [grp, setOpenId]
}
