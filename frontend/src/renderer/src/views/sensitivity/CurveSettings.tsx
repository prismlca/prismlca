import { NumberInput } from '../../components/NumberInput'
import type { MethodInfo } from '../results/types'
import { defaultRange, fmtValue, MAX_POINTS } from './sensitivity'
import type { SensInput } from './types'
import type { CurveSetup } from './useSensitivitySetup'

/**
 * The Parameter curve group of the rail: one parameter, the range and number of points, one indicator, and
 * the variants to draw a line for. A parameter whose rule is a list has no range — its allowed values are
 * the points — and the fields say so instead of offering one.
 */
export function CurveSettings({
  setup,
  patch,
  inputs,
  scenarios,
  families,
  familyNames,
  error
}: {
  setup: CurveSetup
  patch: (p: Partial<CurveSetup>) => void
  inputs: SensInput[] | null
  scenarios: { id: string; name: string }[]
  families: Map<string, MethodInfo[]>
  familyNames: string[]
  /** Why the current settings cannot be computed, from `curveValues`. */
  error: string | null
}): JSX.Element {
  const input = (inputs ?? []).find((i) => i.name === setup.param)
  const isList = input?.rule.kind === 'list'
  const family = setup.method?.[0] ?? familyNames[0] ?? ''
  const familyMethods = families.get(family) ?? []
  const methodKey = setup.method?.join(' · ') ?? ''
  const variants = new Set(setup.variants)
  const toggleVariant = (id: string, on: boolean): void =>
    patch({
      variants: on ? [...setup.variants.filter((v) => v !== id), id] : setup.variants.filter((v) => v !== id)
    })
  return (
    <>
      <label className="settings-field">
        <span>Parameter</span>
        <select
          className="search-sel"
          value={setup.param}
          onChange={(e) => {
            const next = (inputs ?? []).find((i) => i.name === e.target.value)
            // A new parameter starts on a range around its own value; the old ends meant another quantity.
            patch({ param: e.target.value, ...(next ? defaultRange(next) : { from: null, to: null }) })
          }}
        >
          <option value="">Pick a parameter…</option>
          {(inputs ?? []).map((i) => (
            <option key={i.name} value={i.name}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      {input ? (
        <p className="rail-hint">
          Now {fmtValue(input.value)}
          {input.unit ? ` ${input.unit}` : ''}
          {input.allowed ? ` · allowed: ${input.allowed}` : ''}. Tip: a click on a tornado bar picks it here.
        </p>
      ) : (
        <p className="rail-hint">Tip: a click on a tornado bar picks its parameter here.</p>
      )}
      {isList ? (
        <p className="rail-hint">Its rule lists the allowed values; the curve is computed at each of them.</p>
      ) : (
        <div className="sens-trio">
          <label>
            From
            <NumberInput
              disabled={!input}
              value={setup.from ?? 0}
              onValue={(raw) => patch({ from: Number(raw) })}
            />
          </label>
          <label>
            To
            <NumberInput
              disabled={!input}
              value={setup.to ?? 0}
              onValue={(raw) => patch({ to: Number(raw) })}
            />
          </label>
          <label>
            Points
            <NumberInput
              disabled={!input}
              min={2}
              max={MAX_POINTS}
              step={1}
              value={setup.points}
              onValue={(raw) => patch({ points: Math.round(Number(raw)) })}
            />
          </label>
        </div>
      )}
      {error && setup.param ? <p className="rail-hint sens-warn">{error}</p> : null}
      <label className="settings-field">
        <span>Method family</span>
        <select
          className="search-sel"
          value={family}
          onChange={(e) => patch({ method: families.get(e.target.value)?.[0]?.method ?? null })}
        >
          {familyNames.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-field">
        <span>Indicator</span>
        <select
          className="search-sel"
          value={methodKey}
          onChange={(e) =>
            patch({
              method: familyMethods.find((m) => m.method.join(' · ') === e.target.value)?.method ?? null
            })
          }
        >
          {!setup.method ? <option value="">Pick an indicator…</option> : null}
          {familyMethods.map((m) => {
            const key = m.method.join(' · ')
            return (
              <option key={key} value={key}>
                {m.recommended ? '★ ' : ''}
                {m.method.slice(1).join(' · ') || m.method[0]} [{m.unit}]
              </option>
            )
          })}
        </select>
      </label>
      <div className="subj-subhead">Variants</div>
      <div className="subjpick">
        {[{ id: '', name: 'Baseline' }, ...scenarios].map((s) => (
          <label key={s.id} className="subjrow">
            <input
              type="checkbox"
              checked={variants.has(s.id)}
              onChange={(e) => toggleVariant(s.id, e.target.checked)}
            />
            <span title={s.name}>{s.name}</span>
          </label>
        ))}
      </div>
    </>
  )
}
