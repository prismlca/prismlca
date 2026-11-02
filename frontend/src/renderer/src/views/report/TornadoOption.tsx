import { useState } from 'react'
import { methodKey } from '../../components/IndicatorPicker'
import { indicatorLabel } from '../../lib/methods'
import type { StoredReportFull } from '../../lib/report/model'
import { NumberInput } from '../../components/NumberInput'
import { DELTA_PRESETS } from '../sensitivity/sensitivity'

/** The parameter tornado of a report: on or off, which of the report's indicators (method keys), the range. */
export interface TornadoChoice {
  enabled: boolean
  /** Method keys (`methodKey`) of the report's indicators; none chosen prints the first. */
  methods: string[]
  delta: number
}

export const DEFAULT_TORNADO: TornadoChoice = { enabled: false, methods: [], delta: 0.1 }

/** A stored report's `options.tornado` (method paths) as the choice this control edits (method keys). */
export function tornadoFromOptions(
  stored: { enabled?: boolean; methods?: string[][]; delta?: number } | undefined
): Partial<TornadoChoice> {
  if (!stored) return {}
  return {
    enabled: Boolean(stored.enabled),
    methods: (stored.methods ?? []).map((m) => methodKey(m)),
    ...(typeof stored.delta === 'number' ? { delta: stored.delta } : {})
  }
}

/** The indicators a tornado is drawn for: the chosen ones the report still has, or else the first. */
export function tornadoIndicators(choice: TornadoChoice, keys: string[]): string[] {
  const kept = keys.filter((k) => choice.methods.includes(k))
  return kept.length ? kept : keys.slice(0, 1)
}

/**
 * The parameter tornado's setting, the same in the full report's scope card and the short report's rail: one
 * checkbox, then the indicators (one figure each, from those the report already shows) and the range — the
 * Sensitivity analysis tab's presets or a number of one's own. It always runs on the baseline of the
 * reference process; that is said here, because it is the question a reader of the figure asks first.
 */
export default function TornadoOption({
  value,
  indicators,
  onChange,
  unavailable
}: {
  value: TornadoChoice
  /** The report's indicators, as the picker names them. */
  indicators: { key: string; label: string }[]
  onChange: (next: TornadoChoice) => void
  /** Why it cannot print here (the report has no Interpretation checks chapter); nothing when it can. */
  unavailable?: string
}): JSX.Element {
  const [custom, setCustom] = useState(!DELTA_PRESETS.includes(value.delta))
  const shown = tornadoIndicators(
    value,
    indicators.map((i) => i.key)
  )
  return (
    <div className="rtor">
      <label className="rtor-on" title={unavailable || undefined}>
        <input
          type="checkbox"
          disabled={Boolean(unavailable) && !value.enabled}
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span>Parameter sensitivity (tornado)</span>
      </label>
      {unavailable ? <p className="settings-hint">{unavailable}</p> : null}
      {value.enabled && !unavailable ? (
        <>
          <p className="settings-hint">
            Each parameter of the reference process moved on its own, from the baseline — printed under the
            sensitivity check in Interpretation checks, one figure per indicator.
          </p>
          {indicators.length > 1 ? (
            <div className="rtor-ind" role="group" aria-label="Tornado indicators">
              {indicators.map((ind) => (
                <label key={ind.key}>
                  <input
                    type="checkbox"
                    checked={shown.includes(ind.key)}
                    onChange={(e) => {
                      const on = e.target.checked
                      const next = on ? [...shown, ind.key] : shown.filter((k) => k !== ind.key)
                      // At least one stays: none chosen would quietly mean "the first".
                      if (next.length) onChange({ ...value, methods: next })
                    }}
                  />
                  <span>{ind.label}</span>
                </label>
              ))}
            </div>
          ) : null}
          <div className="rtor-range">
            <span>Range</span>
            <span className="seg">
              {DELTA_PRESETS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`seg-btn${!custom && value.delta === d ? ' on' : ''}`}
                  onClick={() => {
                    setCustom(false)
                    onChange({ ...value, delta: d })
                  }}
                >
                  ±{d * 100} %
                </button>
              ))}
              <button
                type="button"
                className={`seg-btn${custom ? ' on' : ''}`}
                onClick={() => setCustom(true)}
              >
                Custom
              </button>
            </span>
            {custom ? (
              <>
                <span>±</span>
                <NumberInput
                  aria-label="Custom range in percent"
                  min={1}
                  max={99}
                  step={1}
                  value={Math.round(value.delta * 1000) / 10}
                  onValue={(raw) => {
                    const v = Number(raw)
                    if (Number.isFinite(v)) onChange({ ...value, delta: Math.min(99, Math.max(1, v)) / 100 })
                  }}
                />
                <span>%</span>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * The control on a stored report's scope card: its `options.tornado` read in, and every change written through
 * the panel's queue as method paths — the indicators the report has *at the moment of writing*, so a pick
 * made from a stale render cannot name an indicator that was removed in between. Unavailable while the
 * report has no Interpretation checks chapter, which is where it prints.
 */
export function StoredTornadoOption({
  report,
  indicatorNames,
  mutate,
  base
}: {
  report: StoredReportFull
  indicatorNames: Map<string, string>
  mutate: (
    method: string,
    path: string,
    body?: object | ((current: StoredReportFull | null) => object | null)
  ) => Promise<boolean>
  base: string
}): JSX.Element {
  return (
    <TornadoOption
      value={{ ...DEFAULT_TORNADO, ...tornadoFromOptions(report.options?.tornado) }}
      indicators={(report.methods ?? []).map((m) => ({
        key: methodKey(m),
        label: indicatorLabel(m, indicatorNames)
      }))}
      unavailable={
        report.sections.some((sec) => sec.kind === 'interpretation_checks')
          ? undefined
          : 'Printed in the Interpretation checks chapter — add that chapter to use it.'
      }
      onChange={(next) =>
        void mutate('POST', base, (r) => ({
          options: {
            ...(r?.options ?? {}),
            tornado: {
              enabled: next.enabled,
              methods: (r?.methods ?? []).filter((m) => next.methods.includes(methodKey(m))),
              delta: next.delta
            }
          }
        }))
      }
    />
  )
}

/** The short report's tornado fields for the backend's `ShortSettings`: the picked indicators the rail chose,
 *  as method paths. */
export function shortTornadoBody(
  settings: { tornado?: boolean; tornado_methods?: string[]; tornado_delta?: number },
  chosen: { method: string[] }[]
): { tornado: boolean; tornado_methods: string[][]; tornado_delta: number } {
  return {
    tornado: Boolean(settings.tornado),
    tornado_methods: chosen
      .filter((m) => (settings.tornado_methods ?? []).includes(methodKey(m.method)))
      .map((m) => m.method),
    tornado_delta: settings.tornado_delta ?? 0.1
  }
}
