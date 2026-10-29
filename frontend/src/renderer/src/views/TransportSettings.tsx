/**
 * Settings → Transport distances: the two keys and the geocoder choice, the GLEC adjustments, the
 * call limits, and a cost table of its own — deliberately NOT part of the AI pages or the AI ledger.
 * The assistant is one of two callers of this feature; the other is the
 * Distances button in the toolbar, which works with the assistant switched off.
 *
 * Every number the sheet prints beside a source comes from shared/distanceDefaults.ts, so the figure
 * and its sentence cannot drift apart. Write-through like every other page: no Save button.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ADJUSTMENT_SOURCES,
  DEFAULT_TRANSPORT,
  DISTANCE_PRICES_CHECKED,
  GLEC_AIR_ADD_KM,
  ACCESS_TERMINAL_RADIUS_M,
  ACCESS_ZERO_BELOW_KM,
  GLEC_ROAD_FACTOR,
  GLEC_SEA_FACTOR,
  MAPBOX_PERMANENT_USD_PER_1000,
  MAX_PER_TURN_CALLS,
  MIN_PER_TURN_CALLS,
  ORS_COLLABORATIVE_PLAN,
  ORS_FREE_PLAN,
  RAIL_CAVEAT,
  RAIL_CIRCUITY_EU,
  RAIL_FACTOR_MAX,
  RAIL_FACTOR_MIN,
  clampRailFactor,
  type GeocodeProvider,
  type TransportSettings
} from '../../../shared/distanceDefaults'
import type { KeyStatus } from '../../../shared/ipc'
import { getAS, setAS, useAppSettings } from '../lib/appSettings'
import {
  distanceAvailability,
  distanceClearKey,
  distanceKeyStatus,
  distanceSetKey,
  distanceUsage,
  type DistanceAvailability,
  type DistanceUsage
} from '../lib/distance'
import { fmtUsd } from '../lib/money'
// The two geocoders' own marks, from their sites (Mapbox in black, as its brand guidelines allow for
// integrations; openrouteservice's header logo). Word marks, so the card needs no name line of its own.
import mapboxLogo from '../assets/logos/mapbox.svg'
import orsLogo from '../assets/logos/openrouteservice.png'
import { NumberInput } from '../components/NumberInput'

export type TransportTab = 'keys' | 'adjustments' | 'limits' | 'costs'

/** The current group, defaults filled in — the store's snapshot may predate main's answer. */
export function useTransport(): TransportSettings {
  const as = useAppSettings()
  return (as.transport as TransportSettings | undefined) ?? DEFAULT_TRANSPORT
}

/** Written as a whole: the group is nested, and main merges settings shallowly. */
export function patchTransport(patch: Partial<TransportSettings>): void {
  const current = (getAS().transport as TransportSettings | undefined) ?? DEFAULT_TRANSPORT
  setAS({ transport: { ...current, ...patch } })
}

/** Reset for the footer button: every choice back to default, the recent lookups kept. */
export function resetTransport(): void {
  const current = (getAS().transport as TransportSettings | undefined) ?? DEFAULT_TRANSPORT
  setAS({ transport: { ...DEFAULT_TRANSPORT, recent: current.recent } })
}

function priceDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
}

const KEY_COPY: Record<
  GeocodeProvider,
  { label: string; placeholder: string; envVar: string; company: string; createAt: string; devfile: string }
> = {
  ors: {
    label: 'openrouteservice API key',
    placeholder: 'your key from account.heigit.org',
    envVar: 'ORS_API_KEY',
    company: 'HeiGIT (openrouteservice)',
    createAt: 'account.heigit.org (free plan, no payment method needed)',
    devfile: '.secrets/ors-key'
  },
  mapbox: {
    label: 'Mapbox access token',
    placeholder: 'pk.…',
    envVar: 'MAPBOX_API_KEY',
    company: 'Mapbox',
    createAt: 'account.mapbox.com under Access tokens',
    devfile: '.secrets/mapbox-key'
  }
}

/** One key field. Same behaviour as the AI provider key block — mask once stored, replace, never read back. */
function DistanceKeyField({
  provider,
  onChanged
}: {
  provider: GeocodeProvider
  onChanged: () => void
}): JSX.Element {
  const copy = KEY_COPY[provider]
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [draft, setDraft] = useState('')
  const abandoned = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = (): void => {
    void distanceKeyStatus(provider)
      .then(setStatus)
      .catch(() => setStatus(null))
  }
  useEffect(load, [provider])

  const commit = async (): Promise<void> => {
    if (abandoned.current) {
      abandoned.current = false
      return
    }
    const v = draft.trim()
    if (!v) return
    setBusy(true)
    setError(null)
    const r = await distanceSetKey(v, provider).catch((e) => ({ ok: false, error: String(e) }))
    setBusy(false)
    if (!r.ok) return setError(r.error || 'The key could not be stored.')
    setDraft('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    load()
    onChanged()
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    await distanceClearKey(provider).catch(() => undefined)
    setBusy(false)
    setDraft('')
    load()
    onChanged()
  }

  const whereItLives = (): string => {
    if (!status) return ''
    if (!status.available)
      return `This system offers no credential store, so PrismLCA will not write a key to disk. Set ${copy.envVar} in the environment instead.`
    if (status.backend === 'keychain') return 'Kept encrypted in your macOS keychain.'
    if (status.backend === 'dpapi') return 'Kept encrypted by Windows DPAPI, for your account only.'
    if (status.trusted) return `Kept encrypted in your desktop keyring (${status.backend}).`
    return `No desktop keyring is running here, so a key on disk would only be obfuscated, not encrypted. Start a keyring, or set ${copy.envVar} in the environment.`
  }

  return (
    <>
      <label className="settings-field settings-key">
        <span>{copy.label}</span>
        <input
          type="password"
          value={draft}
          placeholder={status?.present ? status.hint : copy.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={copy.label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              abandoned.current = true
              setDraft('')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </label>
      <p className="settings-hint">
        {status?.present ? (
          <>
            A key is configured{status.source === 'env' ? ' from the environment' : ''}
            {status.source === 'devfile' ? ' from this checkout' : ''} — <code>{status.hint}</code>.{' '}
            {status.source === 'env'
              ? `${copy.envVar} overrides anything stored here.`
              : status.source === 'devfile'
                ? `It comes from ${copy.devfile} in the working copy. Type a key above and the stored one takes over.`
                : whereItLives()}{' '}
            Typing a new one replaces it; it is never shown again.
          </>
        ) : (
          <>
            No key yet. Create one at {copy.createAt}. {whereItLives()}
          </>
        )}
      </p>
      {saved ? <p className="settings-hint ok">Stored.</p> : null}
      {error ? <p className="settings-hint bad">{error}</p> : null}
      {status?.present && status.source === 'stored' ? (
        <button className="btn sm" disabled={busy} onClick={() => void remove()}>
          Remove the key
        </button>
      ) : null}
    </>
  )
}

function KeysTab(): JSX.Element {
  const t = useTransport()
  const [avail, setAvail] = useState<DistanceAvailability | null>(null)
  const refresh = (): void => {
    void distanceAvailability()
      .then(setAvail)
      .catch(() => setAvail(null))
  }
  useEffect(refresh, [])

  return (
    <>
      <h4>Routing — openrouteservice</h4>
      {/* Three questions, one paragraph each: where the place names go, which service does what, and
          who pays. The second answers the one people ask — Mapbox geocodes, it never routes. */}
      <div className="settings-notice">
        <p>
          Place names you look up — a supplier’s address, a port, a plant — go to the geocoder you pick below:
          HeiGIT’s openrouteservice (Heidelberg, Germany) or Mapbox (USA). An address can be personal data, so
          type only what the distance needs; what happens to it there is governed by your own agreement with
          that service.
        </p>
        <p>
          Mapbox only finds places. Road routes always come from openrouteservice — it receives the
          coordinates, and road legs need its key either way. Air, rail and sea distances are calculated on
          this computer. Mapbox has not been tested with this version. Results from openrouteservice are{' '}
          <strong>© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors</strong> and may
          be stored in your models.
        </p>
        <p>
          <strong>The accounts are yours, and so is the bill.</strong> PrismLCA brakes on its own — limits per
          assistant turn and per day, request pacing, the table under Usage &amp; costs — but a brake can be
          switched off, set too high or fail. Set a spending limit on your Mapbox account and check the usage
          table now and then.
        </p>
      </div>
      <DistanceKeyField provider="ors" onChanged={refresh} />
      <p className="settings-hint">
        Free plan: {ORS_FREE_PLAN.routePerDay.toLocaleString('en-US')} routing and{' '}
        {ORS_FREE_PLAN.geocodePerDay.toLocaleString('en-US')} geocoding requests a day,{' '}
        {ORS_FREE_PLAN.routePerMinute} and {ORS_FREE_PLAN.geocodePerMinute} a minute. PrismLCA paces its
        requests to stay inside those limits. Research, non-profit and public organisations can apply to
        HeiGIT for the free Collaborative plan ({ORS_COLLABORATIVE_PLAN.routePerDay.toLocaleString('en-US')}{' '}
        routing and {ORS_COLLABORATIVE_PLAN.geocodePerDay.toLocaleString('en-US')} geocoding requests a day);
        raise the daily limits under Limits once it is granted.
      </p>

      <h4>Geocoding — who turns a place name into coordinates</h4>
      <div className="provider-cards" role="radiogroup" aria-label="Geocoder">
        {(['ors', 'mapbox'] as GeocodeProvider[]).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={t.geocoder === p}
            aria-label={p === 'ors' ? 'openrouteservice' : 'Mapbox'}
            className={`provider-card${t.geocoder === p ? ' on' : ''}`}
            onClick={() => patchTransport({ geocoder: p })}
          >
            <img
              className="provider-card-logo wide"
              src={p === 'ors' ? orsLogo : mapboxLogo}
              alt={p === 'ors' ? 'openrouteservice' : 'Mapbox'}
            />
            <div className="provider-card-blurb">
              {p === 'ors' ? 'Free · OpenStreetMap' : 'Better addresses · 5 $ / 1 000'}
            </div>
          </button>
        ))}
      </div>
      {t.geocoder === 'mapbox' ? (
        <>
          <p className="settings-notice">
            PrismLCA asks Mapbox for <strong>permanent</strong> geocodes only — the one kind Mapbox allows you
            to store, which a distance in a saved model is. They are billed from the first request at{' '}
            {MAPBOX_PERMANENT_USD_PER_1000} $ per 1 000, with no free allowance, and need a payment method on
            your Mapbox account; without one, lookups fail rather than silently falling back. Results shown in
            PrismLCA are marked “© Mapbox”.
          </p>
          <DistanceKeyField provider="mapbox" onChanged={refresh} />
          {/* Only the chosen geocoder is ever asked: without its key, lookups stay off — the other
              service's key never stands in, so place names reach no one the user did not pick. */}
          {avail && !avail.mapbox && avail.ors ? (
            <p className="settings-hint warn">
              No Mapbox token yet — lookups stay off until there is one. openrouteservice does not stand in.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="settings-hint">
            openrouteservice geocoding (Pelias on OpenStreetMap and OpenAddresses) is free but weaker on
            street addresses outside Europe and North America. Cities and ports resolve well. Switch to Mapbox
            when a plant address does not.
          </p>
          {avail && avail.mapbox && !avail.ors ? (
            <p className="settings-hint warn">
              No openrouteservice key yet — lookups stay off until there is one. Your Mapbox token is used
              only while Mapbox is picked above.
            </p>
          ) : null}
        </>
      )}
      {avail && !avail.ors && !avail.mapbox ? (
        <p className="settings-hint bad">
          No key at all yet — the Distances button and the assistant’s distances tool stay off until there is
          one.
        </p>
      ) : null}
    </>
  )
}

function AdjustmentsTab(): JSX.Element {
  const t = useTransport()
  const [railDraft, setRailDraft] = useState<string>(String(t.railFactor))
  useEffect(() => setRailDraft(String(t.railFactor)), [t.railFactor])
  const toggle = (mode: 'road' | 'air' | 'rail' | 'sea', on: boolean): void =>
    patchTransport({ glec: { ...t.glec, [mode]: on } })

  return (
    <>
      <h4>Distance adjustment factors (DAF)</h4>
      <p className="settings-hint">
        The GLEC Framework (Smart Freight Centre, v3.2, October 2025) and ISO 14083 say which distance a
        transport emission is meant to be based on. These switches apply their conventions to what the router
        or the globe returns; each answer says which one was applied. All on by default.
      </p>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={t.glec.road}
          onChange={(e) => toggle('road', e.target.checked)}
        />
        <span>
          Road: routed distance × {GLEC_ROAD_FACTOR} <span className="muted">(+5 %)</span>
        </span>
      </label>
      <p className="settings-hint">{ADJUSTMENT_SOURCES.road}</p>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={t.glec.air}
          onChange={(e) => toggle('air', e.target.checked)}
        />
        <span>Air: great-circle distance + {GLEC_AIR_ADD_KM} km</span>
      </label>
      <p className="settings-hint">{ADJUSTMENT_SOURCES.air}</p>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={t.glec.rail}
          onChange={(e) => toggle('rail', e.target.checked)}
        />
        <span>Rail: great-circle distance × circuity factor</span>
      </label>
      <label className="settings-field">
        <span>Rail circuity factor</span>
        <input
          type="number"
          min={RAIL_FACTOR_MIN}
          max={RAIL_FACTOR_MAX}
          step={0.01}
          aria-label="Rail circuity factor"
          disabled={!t.glec.rail}
          value={railDraft}
          onChange={(e) => setRailDraft(e.target.value)}
          onBlur={() => patchTransport({ railFactor: clampRailFactor(railDraft) })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </label>
      <p className="settings-hint">
        {ADJUSTMENT_SOURCES.rail} Default {RAIL_CIRCUITY_EU}. <strong>{RAIL_CAVEAT}</strong> Every rail answer
        carries that sentence.
      </p>
      <h4>Access legs</h4>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={t.accessLegs}
          onChange={(e) => patchTransport({ accessLegs: e.target.checked })}
        />
        <span>Air and sea: deliver the road to and from the airport or port as separate legs</span>
      </label>
      <p className="settings-hint">
        The flight or voyage then runs terminal to terminal. Unless a terminal is named, the nearest major
        airport or terminal port by straight line is taken, and each answer says which. The terminal end of a
        road leg snaps to a lorry road within {ACCESS_TERMINAL_RADIUS_M} m; a leg under {ACCESS_ZERO_BELOW_KM}{' '}
        km counts as 0. Needs the openrouteservice key. On by default.
      </p>
      <h4>Sea</h4>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={t.glec.sea}
          onChange={(e) => toggle('sea', e.target.checked)}
        />
        <span>
          Sea: sailed distance × {GLEC_SEA_FACTOR} <span className="muted">(+15 %)</span>
        </span>
      </label>
      <p className="settings-hint">
        {ADJUSTMENT_SOURCES.sea} Inland places are snapped to the nearest sea node; the distance from each
        place to its node is reported separately and never added to the sailed kilometres.
      </p>
    </>
  )
}

function LimitsTab(): JSX.Element {
  const t = useTransport()
  const [avail, setAvail] = useState<DistanceAvailability | null>(null)
  useEffect(() => {
    void distanceAvailability()
      .then(setAvail)
      .catch(() => setAvail(null))
  }, [])
  const num = (v: string, min: number, max: number, dflt: number): number => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
  }
  const noKey = avail !== null && !avail.available

  return (
    <>
      <h4>Assistant</h4>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={t.toolEnabled && !noKey}
          disabled={noKey}
          onChange={(e) => patchTransport({ toolEnabled: e.target.checked })}
        />
        <span>Offer the distances tool to the assistant</span>
      </label>
      <p className="settings-hint">
        {noKey
          ? 'Needs a key for the geocoder picked under API provider — until then the assistant is not even told the tool exists.'
          : 'Off means the assistant is not told the tool exists. The chat’s “+” menu can also switch it off for one conversation.'}
      </p>
      <label className="settings-field">
        <span>API calls per assistant turn</span>
        <NumberInput
          min={MIN_PER_TURN_CALLS}
          max={MAX_PER_TURN_CALLS}
          aria-label="API calls per assistant turn"
          value={t.perTurnCalls}
          onValue={(raw) =>
            patchTransport({
              perTurnCalls: num(raw, MIN_PER_TURN_CALLS, MAX_PER_TURN_CALLS, t.perTurnCalls)
            })
          }
        />
      </label>
      <p className="settings-hint">
        One address pair costs up to three calls (two geocodes and a route); a repeated place or a coordinate
        input costs less. Pairs beyond the limit are named as skipped, never dropped.
      </p>

      <h4>Daily limits (assistant and Distances button together)</h4>
      <label className="settings-field">
        <span>Geocoding calls per day</span>
        <NumberInput
          min={0}
          max={1_000_000}
          aria-label="Geocoding calls per day"
          value={t.dailyCalls.geocode}
          onValue={(raw) =>
            patchTransport({
              dailyCalls: {
                ...t.dailyCalls,
                geocode: num(raw, 0, 1_000_000, t.dailyCalls.geocode)
              }
            })
          }
        />
      </label>
      <label className="settings-field">
        <span>Routing calls per day</span>
        <NumberInput
          min={0}
          max={1_000_000}
          aria-label="Routing calls per day"
          value={t.dailyCalls.route}
          onValue={(raw) =>
            patchTransport({
              dailyCalls: { ...t.dailyCalls, route: num(raw, 0, 1_000_000, t.dailyCalls.route) }
            })
          }
        />
      </label>
      <p className="settings-hint">
        Defaults are the openrouteservice free plan ({ORS_FREE_PLAN.geocodePerDay.toLocaleString('en-US')}{' '}
        geocoding, {ORS_FREE_PLAN.routePerDay.toLocaleString('en-US')} routing a day). 0 = no limit. The day
        is your computer’s calendar day; the count includes Mapbox geocodes, so the same number also caps what
        Mapbox can bill.
      </p>
    </>
  )
}

function CostsTab(): JSX.Element {
  const [usage, setUsage] = useState<DistanceUsage>({})
  useEffect(() => {
    void distanceUsage()
      .then(setUsage)
      .catch(() => {})
  }, [])
  const days = Object.keys(usage).sort().reverse() // newest first
  const today = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const todayKey = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
  const monthKey = todayKey.slice(0, 7)
  const sum = (filter: (day: string) => boolean, field: 'calls' | 'cost', endpoint?: string): number => {
    let s = 0
    for (const day of days) {
      if (!filter(day)) continue
      for (const prov of Object.values(usage[day]))
        for (const [ep, b] of Object.entries(prov)) if (!endpoint || ep === endpoint) s += b[field]
    }
    return s
  }
  const rows = days.flatMap((day) =>
    Object.entries(usage[day]).flatMap(([prov, eps]) =>
      Object.entries(eps).map(([ep, b]) => ({ day, prov, ep, calls: b.calls, cost: b.cost }))
    )
  )

  return (
    <>
      <h4>Distance API usage</h4>
      <p className="settings-hint">
        Calls per day, provider and endpoint, booked by PrismLCA as they go out. openrouteservice is free
        within its plan; Mapbox permanent geocodes are priced from Mapbox’s list<sup>*</sup>. This table is
        separate from the AI costs on purpose — a distance lookup is not a model call.
      </p>
      {rows.length === 0 ? (
        <p className="empty" style={{ padding: 0 }}>
          No distance lookups recorded yet.
        </p>
      ) : (
        <>
          <div className="cost-stats">
            <div className="cost-stat">
              <div className="cost-stat-num">{sum((d) => d === todayKey, 'calls')}</div>
              <div className="cost-stat-label">calls today</div>
            </div>
            <div className="cost-stat">
              <div className="cost-stat-num">{sum((d) => d.startsWith(monthKey), 'calls')}</div>
              <div className="cost-stat-label">calls this month</div>
            </div>
            <div className="cost-stat">
              <div className="cost-stat-num">{fmtUsd(sum((d) => d.startsWith(monthKey), 'cost'))}</div>
              <div className="cost-stat-label">cost this month</div>
            </div>
            <div className="cost-stat">
              <div className="cost-stat-num">{fmtUsd(sum(() => true, 'cost'))}</div>
              <div className="cost-stat-label">cost all time</div>
            </div>
          </div>
          <div className="ai-table-wrap">
            <table className="ai-table cost-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Provider</th>
                  <th>Endpoint</th>
                  <th className="num">Calls</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.day}-${r.prov}-${r.ep}`}>
                    <td>{r.day}</td>
                    <td>{r.prov === 'ors' ? 'openrouteservice' : r.prov === 'mapbox' ? 'Mapbox' : r.prov}</td>
                    <td>{r.ep}</td>
                    <td className="num">{r.calls}</td>
                    <td className="num">{r.cost ? fmtUsd(r.cost) : <span className="cost-none">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="settings-hint">
        <b>*</b> Kept by hand — Mapbox has no pricing API. {MAPBOX_PERMANENT_USD_PER_1000} $ per 1 000
        permanent geocodes as of <b>{priceDate(DISTANCE_PRICES_CHECKED)}</b>; the costs here are estimates
        from that list price.
      </p>
    </>
  )
}

/** One of the four Transport-distances pages; the page choice is the Settings rail's, like the AI pages. */
export default function TransportPanel({ tab }: { tab: TransportTab }): JSX.Element {
  return tab === 'keys' ? (
    <KeysTab />
  ) : tab === 'adjustments' ? (
    <AdjustmentsTab />
  ) : tab === 'limits' ? (
    <LimitsTab />
  ) : (
    <CostsTab />
  )
}
