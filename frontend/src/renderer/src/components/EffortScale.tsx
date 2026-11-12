import {
  effortStepName,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_SHORT,
  type ReasoningEffort
} from '../../../shared/aiDefaults'

/** The position "send nothing, the API decides" — the first tick of every scale. */
export const EFFORT_DEFAULT_TITLE = 'Default — the API decides (for several models well below their best)'

/** The Default tick's hover text, naming the level the API then uses where the vendor documents it. */
const defaultTitle = (apiDefault?: ReasoningEffort): string =>
  apiDefault
    ? `Default — nothing is sent, and the API uses ${REASONING_EFFORT_SHORT[apiDefault].toLowerCase()}`
    : EFFORT_DEFAULT_TITLE

/** The steps both dials draw: Default first, unless the model has a chat floor — then the floor is the
 *  bottom step, and a value of '' sits on it. */
function stepsOf(
  levels: readonly ReasoningEffort[],
  noDefault: boolean | undefined
): (ReasoningEffort | '')[] {
  return noDefault && levels.length ? [...levels] : ['', ...levels]
}

/**
 * The reasoning-effort dial, drawn as a scale: a range input with one tick per level, Default first.
 * One component for both places the dial lives (Settings → AI → Models and the composer), so the
 * two never offer different levels for the same model. The levels come from the catalogue row and
 * are the vendor-documented ones only; an empty list draws a locked scale and says why instead of
 * disappearing, so the control does not move about between models.
 */
export function EffortScale({
  levels,
  value,
  onChange,
  label,
  compact,
  apiDefault,
  noDefault
}: {
  levels: readonly ReasoningEffort[]
  /** '' = Default (nothing sent). */
  value: ReasoningEffort | ''
  onChange: (v: ReasoningEffort | '') => void
  /** The accessible name of the slider. */
  label: string
  /** Tighter spacing for the composer menu. */
  compact?: boolean
  /** The level the API uses on Default, where documented: the tick then reads "Default (medium)". */
  apiDefault?: ReasoningEffort
  /** No Default step: the model has a chat floor and `levels` start at it. */
  noDefault?: boolean
}): JSX.Element {
  const steps = stepsOf(levels, noDefault)
  const idx = Math.max(0, steps.indexOf(value))
  const locked = levels.length === 0
  const tickTitle = (s: ReasoningEffort | ''): string =>
    s === '' ? defaultTitle(apiDefault) : REASONING_EFFORT_LABELS[s]
  return (
    <div
      className={`effort-scale${compact ? ' compact' : ''}${locked ? ' locked' : ''}`}
      style={{ ['--n' as string]: steps.length }}
    >
      {/* The track is one of the app's progress bars: the fill wears the splash gradient sized to
          the track, so pulling the thumb to the top reveals the whole range of colours and a lower
          level only the first part of it. The native range sits transparent on
          top and keeps the keyboard and the thumb. */}
      <div
        className="effort-track"
        style={{ ['--frac' as string]: steps.length > 1 ? idx / (steps.length - 1) : 0 }}
      >
        <span className="effort-fill" aria-hidden="true" />
        {/* One tick per step under the track, at the thumb's centre for that step. */}
        {steps.map((s, i) => (
          <span
            key={`tick-${s || 'default'}`}
            className="effort-tickmark"
            aria-hidden="true"
            style={{ ['--at' as string]: steps.length > 1 ? i / (steps.length - 1) : 0 }}
          />
        ))}
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={idx}
          disabled={locked}
          aria-label={label}
          aria-valuetext={effortStepName(steps[idx], apiDefault)}
          onChange={(e) => onChange(steps[Number(e.target.value)] ?? '')}
        />
      </div>
      {/* The ticks are the same choice again, as targets for the mouse; the keyboard has the slider,
          so they stay out of the tab order and out of the accessibility tree. */}
      <div className="effort-ticks" aria-hidden="true">
        {steps.map((s, i) => (
          <button
            key={s || 'default'}
            type="button"
            tabIndex={-1}
            className={`effort-tick${i === idx ? ' on' : ''}`}
            title={tickTitle(s)}
            disabled={locked}
            onClick={() => onChange(s)}
          >
            {/* Up to seven ticks share the row, so the documented default goes on a line of its own
                under "Default" rather than being cut to "Default (m…". */}
            {s !== '' ? (
              REASONING_EFFORT_SHORT[s]
            ) : apiDefault ? (
              <>
                Default
                <span className="effort-tick-sub">({REASONING_EFFORT_SHORT[apiDefault].toLowerCase()})</span>
              </>
            ) : (
              'Default'
            )}
          </button>
        ))}
      </div>
      {locked ? (
        <div className="effort-note">No levels documented for this model — it runs on its API default.</div>
      ) : null}
    </div>
  )
}

/**
 * The same dial standing up, for the chat's model menu: Default at the foot, the model's top level
 * at the head, every step named beside the track at its own height, the chosen one highlighted
 * (the names are static, not a bubble on the hovered step, so nothing changes width while the thumb
 * moves). Value and levels are {@link EffortScale}'s.
 * `onDragging` tells the owner when the thumb is held, so a flyout that closes on mouse-leave can
 * hold still for the drag.
 */
export function EffortDial({
  levels,
  value,
  onChange,
  label,
  onDragging,
  apiDefault,
  noDefault
}: {
  levels: readonly ReasoningEffort[]
  value: ReasoningEffort | ''
  onChange: (v: ReasoningEffort | '') => void
  label: string
  onDragging?: (held: boolean) => void
  apiDefault?: ReasoningEffort
  noDefault?: boolean
}): JSX.Element {
  const steps = stepsOf(levels, noDefault)
  const idx = Math.max(0, steps.indexOf(value))
  const top = steps.length - 1
  const name = (s: ReasoningEffort | ''): string => effortStepName(s, apiDefault)
  return (
    <div className="effort-dial" style={{ ['--n' as string]: steps.length }}>
      <div className="effort-dial-track" style={{ ['--frac' as string]: top ? idx / top : 0 }}>
        {/* One tick per step, left of the track at the thumb's height for that step. */}
        {steps.map((s, i) => (
          <span
            key={`tick-${s || 'default'}`}
            className="effort-dial-tick"
            aria-hidden="true"
            style={{ ['--at' as string]: top ? i / top : 0 }}
          />
        ))}
        <span className="effort-fill" aria-hidden="true" />
        <input
          type="range"
          min={0}
          max={top}
          step={1}
          value={idx}
          aria-label={label}
          aria-valuetext={name(steps[idx])}
          aria-orientation="vertical"
          onPointerDown={() => onDragging?.(true)}
          onPointerUp={() => onDragging?.(false)}
          onChange={(e) => onChange(steps[Number(e.target.value)] ?? '')}
        />
      </div>
      {/* The names, one per step at the thumb's height for that step; mouse targets like the
          ticks of the flat scale, so out of the tab order and the accessibility tree. */}
      <div className="effort-dial-names" aria-hidden="true">
        {steps.map((s, i) => (
          <button
            key={s || 'default'}
            type="button"
            tabIndex={-1}
            className={`effort-dial-name${i === idx ? ' on' : ''}`}
            style={{ ['--at' as string]: top ? i / top : 0 }}
            title={s === '' ? defaultTitle(apiDefault) : REASONING_EFFORT_LABELS[s]}
            onClick={() => onChange(s)}
          >
            {name(s)}
          </button>
        ))}
      </div>
    </div>
  )
}
