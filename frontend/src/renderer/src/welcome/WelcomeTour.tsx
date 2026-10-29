/**
 * The first-run tour: one card at a time, clicked through to the end.
 *
 * Three deliberate absences, all of them the same decision seen from different
 * sides: there is **no skip button, no close cross and no Escape**, and there is **no "don't show
 * this again" checkbox** (the one checkbox on the last card asks about the start page's news and
 * does nothing to the tour). Reaching the last card and pressing Finish is what marks the tour as seen
 * — nothing else does. Anyone who quits the app halfway is shown it again next time, which is the
 * intended behaviour and not a bug to be smoothed over: the two cards that matter most (whose bill
 * the assistant runs up, and where to report what breaks) are the last two, and a skip button is
 * precisely a way of never reading them.
 *
 * Where it renders matters. On a genuinely fresh install the Workbench stops at the setup gate —
 * no rail, no toolbar, no canvas — so the tour is mounted in App.tsx *beside* the Workbench rather
 * than inside it, and survives whichever half of the app is showing. That is also why every callout
 * is optional: on the very first run almost none of the anchors exist yet, and the one that does —
 * the gate's import tiles — lies under the card (tourGeometry.ts).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { appSettingsReady, setAS, useAppSettings } from '../lib/appSettings'
import { TOUR_CARDS } from './tourCards'
import NewsChoice from './NewsChoice'
import { computeArrow, spotFor, type Arrow, type Spot } from './tourGeometry'

export default function WelcomeTour(): JSX.Element | null {
  const settings = useAppSettings()
  const [open, setOpen] = useState(false)
  const [i, setI] = useState(0)
  /**
   * The flag going false is what opens the tour — on a fresh install, and again when Overview's
   * "Take the tour again" clears it. Deliberately not a once-per-mount decision: that version could
   * not be reopened without reloading the renderer, because the second showing arrives as a change
   * to this very setting, not as a new mount.
   *
   * It waits for `appSettingsReady`, and that wait is the whole subtlety. Before main answers, the
   * store holds the legacy browser seed, where this key reads false because it never existed there
   * — so acting on it would flash the tour at every user who has long since finished it.
   *
   * Finish sets `open` false itself and then writes true, so this effect sees true and does nothing.
   */
  useEffect(() => {
    if (!appSettingsReady()) return
    if (settings.welcomeTourDone === false) {
      setOpen(true)
      setI(0)
    }
  }, [settings.welcomeTourDone])
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [spot, setSpot] = useState<Spot | null>(null)
  const [arrow, setArrow] = useState<Arrow | null>(null)

  const card = TOUR_CARDS[i]
  const last = i === TOUR_CARDS.length - 1

  const place = useCallback(() => {
    const anchor = card.anchor
    const el = anchor ? document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`) : null
    const box = cardRef.current?.getBoundingClientRect()
    if (!el || !box) {
      setSpot(null)
      setArrow(null)
      return
    }
    // Collapsed, or under the card: then the card stands alone, as without an anchor (tourGeometry.ts).
    const s = spotFor(el.getBoundingClientRect(), box)
    setSpot(s)
    setArrow(s ? computeArrow(box, s, window.innerWidth) : null)
  }, [card.anchor])

  useLayoutEffect(() => {
    if (!open) return
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, place])

  const finish = useCallback(() => {
    setOpen(false)
    setAS({ welcomeTourDone: true })
  }, [])

  const next = useCallback(() => {
    if (last) finish()
    else setI((n) => Math.min(n + 1, TOUR_CARDS.length - 1))
  }, [last, finish])

  // Arrow keys page the tour; Escape is deliberately not handled — see the file comment. The
  // listener is capturing so the app underneath never sees these keys while the tour is up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // A key meant for a field on a card — the news checkbox on the last one — is the field's: Enter
      // there must not finish the tour, and an arrow must not page away under it.
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, select, textarea')) return
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setI((n) => Math.max(0, n - 1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, next])

  if (!open) return null

  return (
    <div className="wt-root" role="dialog" aria-modal="true" aria-label="Welcome to PrismLCA">
      {/* Exactly ONE layer may darken the screen. With an anchor that job belongs to the ring, whose
          shadow dims everything around the element it rings; this plain sheet covers the cards that
          have no anchor. Rendering both at once is what put a grey film over the card itself. */}
      {spot ? null : <div className="wt-backdrop" />}

      {spot ? (
        <>
          <div
            className="wt-ring"
            style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
            aria-hidden
          />
          {arrow?.path ? (
            <svg className="wt-arrow" aria-hidden>
              <path d={arrow.path} className="wt-arrow-line" />
              <circle cx={arrow.tip.x} cy={arrow.tip.y} r="4" className="wt-arrow-tip" />
            </svg>
          ) : null}
          {arrow?.note && card.anchorNote ? (
            <div className="wt-anchor-note" style={{ top: arrow.note.y, left: arrow.note.x }}>
              {card.anchorNote}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="wt-card" ref={cardRef}>
        {/* The app's own brand classes, not a copy of them: `.brand` and `.brand-name` are what the
            sidebar wears three centimetres to the left, so the two can never drift apart in build or
            weight. `.wt-brand` adds this card's padding and, deliberately, one size up — see the CSS. */}
        <div className="wt-brand brand">
          <span className="prism" />
          <span className="brand-name">
            Prism<b>LCA</b>
          </span>
        </div>

        <div className="wt-body">
          <div className="wt-text">
            <div className="wt-kicker">{card.kicker}</div>
            <h2>{card.title}</h2>
            {card.body}
          </div>
          <div className="wt-visual">{card.visual}</div>
        </div>

        <div className="wt-foot">
          <div className="wt-count">
            {i + 1} of {TOUR_CARDS.length}
          </div>
          <div className="wt-dots" aria-hidden>
            {TOUR_CARDS.map((c, n) => (
              <span key={c.id} className={`wt-dot${n === i ? ' on' : ''}${n < i ? ' done' : ''}`} />
            ))}
          </div>
          <NewsChoice highlight={last} />
          <div className="wt-acts">
            <button className="btn" disabled={i === 0} onClick={() => setI((n) => Math.max(0, n - 1))}>
              Back
            </button>
            <button className="btn primary" autoFocus onClick={next}>
              {last ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
