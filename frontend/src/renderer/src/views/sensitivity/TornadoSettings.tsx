import { useState } from 'react'
import { NumberInput } from '../../components/NumberInput'
import { IndicatorPicker } from '../results/IndicatorPicker'
import { DELTA_PRESETS, fmtValue } from './helpers'
import type { SensInput } from './types'
import type { TornadoSetup } from './useSensitivitySetup'

/**
 * The Tornado group of the rail: which parameters (all inputs, or a choice), how far each is moved, from which
 * variant, and on which indicators. A parameter calculated from others is not offered — its drivers already
 * move it — and the list says so instead of leaving it out silently.
 */
export function TornadoSettings({
  setup,
  patch,
  inputs,
  derived,
  scenarios,
  picker
}: {
  setup: TornadoSetup
  patch: (p: Partial<TornadoSetup>) => void
  inputs: SensInput[] | null
  derived: string[]
  scenarios: { id: string; name: string }[]
  picker: React.ComponentProps<typeof IndicatorPicker>
}): JSX.Element {
  const preset = DELTA_PRESETS.includes(setup.delta)
  const [custom, setCustom] = useState(!preset)
  const chosen = new Set(setup.params)
  const toggle = (name: string, on: boolean): void =>
    patch({
      params: on ? [...setup.params.filter((p) => p !== name), name] : setup.params.filter((p) => p !== name)
    })
  return (
    <>
      <label className="settings-field">
        <span>Parameters</span>
        <span className="seg">
          <button
            className={`seg-btn${setup.mode === 'all' ? ' on' : ''}`}
            onClick={() => patch({ mode: 'all' })}
          >
            Assess all, show top 10
          </button>
          <button
            className={`seg-btn${setup.mode === 'pick' ? ' on' : ''}`}
            onClick={() => patch({ mode: 'pick' })}
          >
            Choose
          </button>
        </span>
      </label>
      {setup.mode === 'pick' ? (
        <>
          <div className="sens-pchk">
            {(inputs ?? []).map((i) => (
              <label key={i.name}>
                <input
                  type="checkbox"
                  checked={chosen.has(i.name)}
                  onChange={(e) => toggle(i.name, e.target.checked)}
                />
                <span>{i.name}</span>
                <small>
                  {fmtValue(i.value)}
                  {i.unit ? ` ${i.unit}` : ''}
                </small>
              </label>
            ))}
          </div>
          <p className="rail-hint">
            {chosen.size} of {inputs?.length ?? 0} chosen.
            {derived.length ? ` Not offered — calculated from other parameters: ${derived.join(', ')}.` : ''}
          </p>
        </>
      ) : null}
      <label className="settings-field">
        <span>Range</span>
        <span className="seg">
          {DELTA_PRESETS.map((d) => (
            <button
              key={d}
              className={`seg-btn${!custom && setup.delta === d ? ' on' : ''}`}
              onClick={() => {
                setCustom(false)
                patch({ delta: d })
              }}
            >
              ±{d * 100} %
            </button>
          ))}
          <button className={`seg-btn${custom ? ' on' : ''}`} onClick={() => setCustom(true)}>
            Custom
          </button>
        </span>
      </label>
      {custom ? (
        <label className="settings-field">
          <span>Custom range ± (%)</span>
          <NumberInput
            min={1}
            max={99}
            step={1}
            value={Math.round(setup.delta * 1000) / 10}
            onValue={(raw) => {
              const v = Number(raw)
              if (Number.isFinite(v)) patch({ delta: Math.min(99, Math.max(1, v)) / 100 })
            }}
          />
        </label>
      ) : null}
      <p className="rail-hint">
        Each parameter stays within its allowed values. One that cannot move the full range is marked with *.
      </p>
      <label className="settings-field">
        <span>Variant</span>
        <select
          className="search-sel"
          value={setup.scenario}
          onChange={(e) => patch({ scenario: e.target.value })}
        >
          <option value="">Baseline</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="subj-subhead">Indicators</div>
      <IndicatorPicker {...picker} />
    </>
  )
}
