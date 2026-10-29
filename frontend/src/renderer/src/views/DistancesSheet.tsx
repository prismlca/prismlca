/**
 * The Distances panel, opened from the toolbar on the Model, Parameters and Scenarios pages: one
 * mode, two places, the kilometres — and a copy button, because the number's destination is an
 * exchange amount or a parameter on the page underneath, not this sheet.
 *
 * Same service as the assistant's tool (main/distance), so a figure the user looks up and a figure
 * the assistant looks up can never disagree. The last five lookups stay visible with their own copy
 * buttons; they live in the app settings, not in a browser store, and survive a restart.
 *
 * Attribution is not small print here: which geocoder answered stands in the title row while the
 * sheet is open, and the routing line at the foot names openrouteservice and OpenStreetMap.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ATTRIBUTION_GEOCODER,
  OSM_COPYRIGHT_URL,
  RECENT_DISTANCES_KEPT,
  recentKey,
  type RecentDistance,
  type SeaVia,
  type TransportMode
} from '../../../shared/distanceDefaults'
import { CopyIcon, PlaneIcon, ShipIcon, TrainIcon, TruckIcon } from '../components/icons'
import {
  distanceAvailability,
  distanceCancel,
  distanceCompute,
  distanceSuggest,
  type DistanceAvailability,
  type DistanceBatch,
  type PlaceSuggestion
} from '../lib/distance'
import { patchTransport, useTransport } from './TransportSettings'
import EscapeCloser from '../components/EscapeCloser'
import { kmText, resultView } from '../lib/distanceResult'

const MODES: Array<{ key: TransportMode; label: string; Icon: () => JSX.Element }> = [
  { key: 'road', label: 'Road', Icon: TruckIcon },
  { key: 'sea', label: 'Sea', Icon: ShipIcon },
  { key: 'air', label: 'Air', Icon: PlaneIcon },
  { key: 'rail', label: 'Rail', Icon: TrainIcon }
]
const ICON: Record<TransportMode, () => JSX.Element> = {
  road: TruckIcon,
  sea: ShipIcon,
  air: PlaneIcon,
  rail: TrainIcon
}

export { kmText }
/** A kilometre figure as it is read: thin groups of three ("6 107.3"). */
const kmShown = (km: number): string => kmText(km).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Wait this long after the last keystroke before asking for suggestions: a typeahead that fires per
 *  key would spend the openrouteservice minute allowance (100 geocoding calls) on one address. */
export const SUGGEST_DEBOUNCE_MS = 300
const SUGGEST_MIN_CHARS = 3

/**
 * One place field with typeahead. Suggestions come from openrouteservice (never Mapbox, which bills
 * per request) — or, in air and sea mode, from the bundled airport / port catalogue, which is local
 * and free. Debounced, and never for a coordinate pair. Choosing one puts its label in the field; a
 * catalogue label carries its code, so the lookup resolves it without geocoding.
 */
function PlaceInput({
  label,
  value,
  onChange,
  onEnter,
  resolved,
  suggestions,
  kind,
  majorOnly
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onEnter: () => void
  resolved: string
  /** Whether to ask openrouteservice at all (it is the effective geocoder). */
  suggestions: boolean
  /** Air / sea: suggest from the catalogue instead. */
  kind?: 'airport' | 'port'
  majorOnly?: boolean
}): JSX.Element {
  const [items, setItems] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const chosen = useRef<string | null>(null)
  // Suggestions that arrive after the field lost focus must not pop the list open over the result
  // (first practice run: both lists stood open across the answer after Compute).
  const focused = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const text = value.trim()
    // Nothing to ask for: too short, a coordinate pair, or exactly the suggestion just chosen.
    if (
      (!suggestions && !kind) ||
      text.length < SUGGEST_MIN_CHARS ||
      /^-?\d/.test(text) ||
      text === chosen.current
    ) {
      setItems([])
      return
    }
    const mine = ++seq.current
    timer.current = setTimeout(() => {
      void distanceSuggest(text, kind ? { kind, majorOnly } : {})
        .then((list) => {
          if (seq.current !== mine) return // a newer keystroke superseded this request
          setItems(list)
          setOpen(list.length > 0 && focused.current)
        })
        .catch(() => setItems([]))
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [value, suggestions, kind, majorOnly])

  const pick = (s: PlaceSuggestion): void => {
    chosen.current = s.label
    setItems([])
    setOpen(false)
    onChange(s.label)
  }

  return (
    <label className="dist-field">
      {label}
      <input
        value={value}
        placeholder={
          kind === 'airport'
            ? 'place, airport, IATA code or “lat, lon”'
            : kind === 'port'
              ? 'place, port, UN/LOCODE or “lat, lon”'
              : 'place, address or “lat, lon”'
        }
        autoComplete="off"
        onChange={(e) => {
          chosen.current = null
          onChange(e.target.value)
        }}
        onFocus={() => {
          focused.current = true
          if (items.length) setOpen(true)
        }}
        onBlur={() => {
          focused.current = false
          setOpen(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation() // closes the suggestions, not the sheet
            setOpen(false)
          }
          if (e.key === 'Enter') {
            if (open && items.length) pick(items[0])
            else onEnter()
          }
        }}
      />
      <span className="dist-resolved">{resolved}</span>
      {open && items.length ? (
        <ul className="dist-suggest" role="listbox" aria-label={`Suggestions for ${label}`}>
          {items.map((s) => (
            <li key={`${s.lat},${s.lon}`} role="option" aria-selected={false}>
              {/* onMouseDown, not onClick: it runs before the input's blur closes the list. */}
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </label>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])
  return (
    <button
      className="btn sm ico-label"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setDone(true)
          timer.current = setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      <CopyIcon /> {done ? 'Copied' : 'Copy km'}
    </button>
  )
}

/**
 * One result: the legs as rows — each with its own number and copy button, the main leg larger — then
 * the hints that say what to do, the caveats that change what a number means, and, folded away, how
 * each figure was made. The attribution stands under it unshortened: the providers' terms ask for it
 * wherever their results are shown.
 */
function ResultBox({
  view,
  attribution
}: {
  view: ReturnType<typeof resultView>
  attribution: string
}): JSX.Element {
  return (
    <div className="dist-result" aria-live="polite">
      <ol className="dist-legs" aria-label="Legs">
        {view.legs.map((leg) => {
          const Icon = ICON[leg.mode]
          return (
            <li key={leg.key} className={`dist-leg${leg.key === 'main' ? ' main' : ''}`}>
              <span className="dist-leg-ico" aria-hidden="true">
                <Icon />
              </span>
              <span className="dist-leg-what">
                <span className="dist-leg-label">{leg.label}</span>
                <span className="dist-leg-path" title={leg.title}>
                  {leg.path}
                </span>
              </span>
              {leg.km !== null ? (
                <>
                  <span className="dist-leg-km">
                    <b>{kmShown(leg.km)}</b> km
                  </span>
                  <CopyButton
                    text={kmText(leg.km)}
                    label={leg.key === 'main' ? 'Copy kilometres' : `Copy ${kmText(leg.km)} km road leg`}
                  />
                </>
              ) : (
                <span className="dist-leg-km bad">{leg.key === 'main' ? 'no result' : 'not measured'}</span>
              )}
              {leg.km === null && leg.error ? <p className="dist-leg-note bad">{leg.error}</p> : null}
              {leg.warnings.map((w) => (
                <p key={w} className="dist-leg-note warn">
                  {w}
                </p>
              ))}
            </li>
          )
        })}
      </ol>
      {view.hints.map((h) => (
        <p key={h} className="dist-detail">
          {h}
        </p>
      ))}
      {view.notices.map((n) => (
        <p key={n} className="dist-detail warn">
          {n}
        </p>
      ))}
      {view.details.length ? (
        <details className="dist-how">
          <summary>How these figures were made</summary>
          <ul>
            {view.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="dist-attrib">{attribution}</p>
    </div>
  )
}

export default function DistancesSheet({
  onClose,
  onOpenSettings
}: {
  onClose: () => void
  /** Jump to Settings → Transport distances (no key yet, or to change the geocoder). */
  onOpenSettings: () => void
}): JSX.Element {
  const transport = useTransport()
  const [avail, setAvail] = useState<DistanceAvailability | null>(null)
  const [mode, setMode] = useState<TransportMode>('road')
  // Sea only: the network's shortest route (Suez) or round the Cape — a study's assumption, so it is
  // the user's choice here and travels with the recent entry.
  const [via, setVia] = useState<SeaVia>('shortest')
  // Sea only: suggest only the ports the searoute list flags as terminals. A view filter for the
  // typeahead, not a setting — a typed name or code resolves either way.
  const [terminalsOnly, setTerminalsOnly] = useState(true)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DistanceBatch | null>(null)
  // Which lookup is the current one. Stop bumps it, so the answer of a stopped lookup (the service
  // resolves with "Stopped." for what was still open) is recognised as stale and never shown.
  const runRef = useRef(0)

  useEffect(() => {
    void distanceAvailability()
      .then(setAvail)
      .catch(() => setAvail(null))
  }, [])

  const canRoad = !!avail?.ors
  const ready = !!avail?.available && !busy && from.trim() !== '' && to.trim() !== ''

  const stop = (): void => {
    runRef.current += 1
    setBusy(false)
    void distanceCancel().catch(() => undefined)
  }

  const compute = async (): Promise<void> => {
    if (!ready) return
    const run = ++runRef.current
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const out = await distanceCompute({
        mode,
        from: from.trim(),
        to: to.trim(),
        ...(mode === 'sea' && via === 'cape' ? { via: 'cape' as const } : {})
      })
      if (run !== runRef.current) return
      setResult(out)
      const r = out.results[0]
      if (r && typeof r.km === 'number') {
        const entry: RecentDistance = {
          mode,
          from: from.trim(),
          to: to.trim(),
          km: r.km,
          at: new Date().toISOString(),
          geocoder: out.geocoder,
          ...(mode === 'sea' && via === 'cape' ? { via: 'cape' as const } : {}),
          ...(r.crossing ? { crossing_km: r.crossing.km } : {}),
          ...(r.access
            ? {
                access: Object.fromEntries(
                  (['from', 'to'] as const)
                    .filter((side) => r.access?.[side])
                    .map((side) => {
                      const l = r.access![side]!
                      return [
                        side,
                        {
                          code: l.code,
                          ...(typeof l.km === 'number' ? { km: l.km } : { failed: true as const }),
                          ...(l.crossing ? { crossing_km: l.crossing.km } : {}),
                          ...(l.crossings === 'unresolved' ? { unchecked: true as const } : {})
                        }
                      ]
                    })
                )
              }
            : {}),
          ...(r.crossings === 'unresolved' ? { crossing_unchecked: true as const } : {})
        }
        // The same lookup again moves to the top instead of appearing twice.
        const same = (r: RecentDistance): boolean => recentKey(r) === recentKey(entry)
        patchTransport({
          recent: [entry, ...transport.recent.filter((r) => !same(r))].slice(0, RECENT_DISTANCES_KEPT)
        })
      }
    } catch (e) {
      if (run !== runRef.current) return
      const raw = e instanceof Error ? e.message : String(e)
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/i, ''))
    } finally {
      if (run === runRef.current) setBusy(false)
    }
  }

  const pair = result?.results[0]
  const geocoderLine = avail?.geocoder ? ATTRIBUTION_GEOCODER[avail.geocoder] : null

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div
        className="modal sheet dist-sheet"
        role="dialog"
        aria-label="Distances"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Distances</h3>
            <p>
              Kilometres between two places, one way, for a transport leg.{' '}
              {geocoderLine ? <span className="chip muted">{geocoderLine}</span> : null}
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {avail && !avail.available ? (
            <p className="settings-notice">
              Distances need a key for the geocoder picked in Settings.{' '}
              <button className="btn sm" onClick={onOpenSettings}>
                Open Settings → Transport distances
              </button>
            </p>
          ) : null}

          <div className="dist-modes type-chips" role="radiogroup" aria-label="Transport mode">
            {MODES.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                className={`tchip dist-mode${mode === key ? ' on' : ''}`}
                disabled={key === 'road' && avail !== null && !canRoad}
                title={
                  key === 'road' && avail !== null && !canRoad
                    ? 'Road routing needs an openrouteservice key'
                    : label
                }
                onClick={() => setMode(key)}
              >
                <Icon /> {label}
              </button>
            ))}
          </div>
          {mode === 'sea' ? (
            <div className="dist-modes dist-via type-chips" role="radiogroup" aria-label="Sea routing">
              <button
                type="button"
                role="radio"
                aria-checked={via === 'shortest'}
                className={`tchip${via === 'shortest' ? ' on' : ''}`}
                title="The network's shortest route — through Suez or Panama where that is shorter"
                onClick={() => setVia('shortest')}
              >
                Shortest route
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={via === 'cape'}
                className={`tchip${via === 'cape' ? ' on' : ''}`}
                title="Round the Cape of Good Hope, Suez and Panama avoided — the routing much Asia–Europe traffic has used since late 2023"
                onClick={() => setVia('cape')}
              >
                Around the Cape
              </button>
              <label className="settings-hint dist-terminals">
                <input
                  type="checkbox"
                  checked={terminalsOnly}
                  onChange={(e) => setTerminalsOnly(e.target.checked)}
                />
                Suggest terminal ports only
              </label>
            </div>
          ) : null}

          <div className="dist-io">
            <PlaceInput
              label="From"
              value={from}
              onChange={setFrom}
              onEnter={() => void compute()}
              suggestions={avail?.geocoder === 'ors'}
              kind={mode === 'air' ? 'airport' : mode === 'sea' ? 'port' : undefined}
              majorOnly={mode === 'sea' && terminalsOnly}
              resolved={pair?.from.resolved && pair.from.text === from.trim() ? pair.from.resolved : ''}
            />
            <PlaceInput
              label="To"
              value={to}
              onChange={setTo}
              onEnter={() => void compute()}
              suggestions={avail?.geocoder === 'ors'}
              kind={mode === 'air' ? 'airport' : mode === 'sea' ? 'port' : undefined}
              majorOnly={mode === 'sea' && terminalsOnly}
              resolved={pair?.to.resolved && pair.to.text === to.trim() ? pair.to.resolved : ''}
            />
          </div>

          <div className="dist-actions">
            <button className="btn primary" disabled={!ready} onClick={() => void compute()}>
              {busy ? (
                <>
                  <span className="spinner" /> Looking up…
                </>
              ) : (
                'Compute'
              )}
            </button>
            {busy ? (
              <button className="btn" onClick={stop} title="Stop this lookup; nothing is shown or remembered">
                Stop
              </button>
            ) : null}
            {avail?.geocoder === 'mapbox' ? (
              <span className="settings-hint">Each new place costs one Mapbox permanent geocode.</span>
            ) : null}
          </div>

          {error ? <p className="dist-detail bad">{error}</p> : null}

          {pair && result ? (
            <ResultBox view={resultView(result.mode, pair, result)} attribution={result.attribution} />
          ) : null}

          {transport.recent.length ? (
            <>
              <div className="mi-sechead">
                <span className="mi-swatch" aria-hidden="true" />
                <h4>Recent</h4>
              </div>
              <ul className="dist-recent" aria-label="Recent lookups">
                {transport.recent.map((r, i) => {
                  const Icon = ICON[r.mode]
                  return (
                    <li key={`${r.at}-${i}`}>
                      <span title={r.mode} aria-label={r.mode}>
                        <Icon />
                      </span>
                      {/* Click a past lookup and it is back in the fields above, ready to repeat or vary. */}
                      <button
                        type="button"
                        className="route"
                        title={`Put ${r.from} → ${r.to} (${r.mode}) back into the fields`}
                        onClick={() => {
                          setMode(r.mode)
                          setVia(r.via === 'cape' ? 'cape' : 'shortest')
                          setFrom(r.from)
                          setTo(r.to)
                          setResult(null)
                          setError(null)
                        }}
                      >
                        {r.from} → {r.to}
                      </button>
                      <span className="km">{kmText(r.km)} km</span>
                      {r.access
                        ? (['from', 'to'] as const).map((side) => {
                            const l = r.access?.[side]
                            if (!l) return null
                            const bad = l.failed || l.crossing_km || l.unchecked
                            return (
                              <span
                                key={side}
                                className={`chip${bad ? ' warn' : ' muted'}`}
                                title={
                                  l.failed
                                    ? 'This road leg was not measured — the chain is incomplete'
                                    : 'Road leg to or from the terminal — not in the figure'
                                }
                              >
                                {side === 'from' ? 'road to' : 'road from'} {l.code}{' '}
                                {l.failed ? 'not measured' : `${kmText(l.km ?? 0)} km`}
                                {l.crossing_km ? ` + ${kmText(l.crossing_km)} km ferry/shuttle` : ''}
                                {l.unchecked ? ' (ferries unchecked)' : ''}
                              </span>
                            )
                          })
                        : null}
                      {r.crossing_km ? (
                        <span
                          className="chip muted"
                          title="On a ferry or a vehicle shuttle train — not in the figure; enter it as its own leg"
                        >
                          + {kmText(r.crossing_km)} km ferry/shuttle
                        </span>
                      ) : r.crossing_unchecked ? (
                        <span
                          className="chip muted"
                          title="The route could not be checked for ferry or shuttle-train crossings"
                        >
                          not checked for ferries
                        </span>
                      ) : null}
                      <CopyButton text={kmText(r.km)} label={`Copy ${kmText(r.km)} km`} />
                    </li>
                  )
                })}
              </ul>
            </>
          ) : null}

          <p className="dist-foot">
            Routing © openrouteservice.org by HeiGIT | Map data ©{' '}
            <a
              href={OSM_COPYRIGHT_URL}
              onClick={(e) => {
                e.preventDefault()
                void window.prism.openExternal(OSM_COPYRIGHT_URL)
              }}
            >
              OpenStreetMap contributors
            </a>
            . Sea routes: searoute on the Eurostat shipping-lane network; ports from its UN/LOCODE list. Air
            and rail: great-circle distance (WGS84); airports from OurAirports (public domain). Distances are
            one way.
          </p>
        </div>
      </div>
    </div>
  )
}
