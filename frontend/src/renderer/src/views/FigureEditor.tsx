import type { FigureSpec } from './Report'
import { AddIcon, InfoIcon } from '../components/icons'
import { NumberInput } from '../components/NumberInput'

/**
 * What a chapter draws, chapter by chapter.
 *
 * The report used to decide its figures centrally: three switches on the card said whether the document got
 * a heatmap, a radar, and its contribution stacked or grouped — for every chapter at once. That is the wrong
 * place for the decision. The chapter about contributions wants its phases as bars and possibly the same
 * numbers as a heatmap; the executive summary wants one chart and no more; the interpretation chapter may want
 * the comparison drawn a second way to argue with. So the list lives on the chapter, in the editor you open to
 * work on that chapter, and the report-wide switches stay only for the standard comparison figures.
 *
 * A figure is a *drawing of data the report already has* — never a new calculation. The source and the field
 * come from a whitelist the backend validates, which is what makes it safe to let an author (or the assistant)
 * ask for a chart without anybody writing code or trusting a model's arithmetic. The rest — bars across or up,
 * stacked or side by side, how many rows — is presentation and cannot be wrong about the numbers.
 *
 * Colours are not offered here on purpose. Every figure is drawn in the report's own colour set (Appearance),
 * with the series colours derived from it, so a document cannot end up with charts from a different palette
 * than its type. One choice, one look.
 */

type Props = {
  figures: FigureSpec[]
  /** Persist the whole list — order is drawing order. */
  onChange: (figures: FigureSpec[]) => void
  /** False while the report has a single subject: a heatmap or radar of one variant compares nothing. */
  canCompare: boolean
  /** How many indicators the report carries — a radar needs more than three to be a shape and not a line. */
  indicatorCount: number
}

const KINDS: { kind: string; label: string; hint: string }[] = [
  { kind: 'bar', label: 'Bar chart', hint: 'One bar per row of the source' },
  { kind: 'stacked_bar', label: 'Stacked bars', hint: 'One bar per variant, split by contribution group' },
  {
    kind: 'heatmap',
    label: 'Heatmap',
    hint: 'Variants × indicators, each cell as a share of the column’s largest'
  },
  { kind: 'radar', label: 'Radar', hint: 'Variants over all indicators, each normalised to its own maximum' }
]

/** Source → what can be plotted from it, and what the rows are called. The backend holds the same table. */
const SOURCES: { source: string; label: string; values: { value: string; label: string }[] }[] = [
  {
    source: 'contribution.groups',
    label: 'Contribution by group',
    values: [
      { value: 'impact', label: 'Impact' },
      { value: 'share_percent', label: 'Share (%)' }
    ]
  },
  {
    source: 'hotspots',
    label: 'Largest single processes',
    values: [
      { value: 'direct', label: 'Direct impact' },
      { value: 'share_percent', label: 'Share (%)' }
    ]
  },
  {
    source: 'inventory.flows',
    label: 'Elementary flows',
    values: [
      { value: 'impact', label: 'Impact' },
      { value: 'share_percent', label: 'Share (%)' }
    ]
  },
  { source: 'subjects', label: 'Variants (leading indicator)', values: [] }
]

const LABEL_FIELD: Record<string, string> = {
  'contribution.groups': 'key',
  hotspots: 'name',
  'inventory.flows': 'flow',
  subjects: 'label'
}

const isComparison = (kind: string): boolean => kind === 'heatmap' || kind === 'radar'

function blank(): FigureSpec {
  return {
    kind: 'bar',
    source: 'contribution.groups',
    value: 'impact',
    label: 'key',
    rows: 15,
    horizontal: true,
    stacked: false
  }
}

export default function FigureEditor({ figures, onChange, canCompare, indicatorCount }: Props): JSX.Element {
  const set = (i: number, patch: Partial<FigureSpec>): void =>
    onChange(figures.map((f, n) => (n === i ? { ...f, ...patch } : f)))

  return (
    <div className="rsec-instruction">
      <div className="rsec-head">
        <span className="modal-h">Figures</span>
        {/* Six is the backend's ceiling: more than that is a chapter of charts, and it should be split. */}
        <button
          className="btn sm"
          disabled={figures.length >= 6}
          onClick={() => onChange([...figures, blank()])}
        >
          <AddIcon /> Add a figure
        </button>
      </div>

      {figures.length === 0 ? (
        <div className="rsec-note">
          <InfoIcon />
          <span>
            No figure. That is a complete answer — a chapter that argues in words needs no chart, and one
            drawn because it was possible is decoration. Every figure is drawn from numbers this report
            already has, in the colour set chosen under Appearance.
          </span>
        </div>
      ) : null}

      {figures.map((f, i) => {
        const src = SOURCES.find((s) => s.source === f.source) ?? SOURCES[0]
        const rowKind = !isComparison(f.kind)
        const radarTooFew = f.kind === 'radar' && indicatorCount < 4
        return (
          <div className="rsec-fig" key={i}>
            <div className="rsec-figopts">
              <label>
                <span>Kind</span>{' '}
                <select
                  value={f.kind}
                  onChange={(e) => {
                    const kind = e.target.value
                    set(i, {
                      kind,
                      stacked: kind === 'stacked_bar',
                      // A comparison figure has no source; going back to bars needs one again.
                      ...(isComparison(kind) ? {} : { source: f.source || 'contribution.groups' })
                    })
                  }}
                >
                  {KINDS.map((k) => (
                    <option key={k.kind} value={k.kind} title={k.hint}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>

              {rowKind ? (
                <>
                  <label>
                    <span>From</span>{' '}
                    <select
                      value={f.source}
                      onChange={(e) => {
                        const source = e.target.value
                        const first = SOURCES.find((s) => s.source === source)?.values[0]?.value ?? ''
                        set(i, { source, value: first, label: LABEL_FIELD[source] ?? 'key' })
                      }}
                    >
                      {SOURCES.map((s) => (
                        <option key={s.source} value={s.source}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {src.values.length ? (
                    <label>
                      <span>Plot</span>{' '}
                      <select value={f.value} onChange={(e) => set(i, { value: e.target.value })}>
                        {src.values.map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label>
                    <span>Bars</span>{' '}
                    <select
                      value={f.horizontal === false ? 'v' : 'h'}
                      onChange={(e) => set(i, { horizontal: e.target.value === 'h' })}
                    >
                      <option value="h">Across</option>
                      <option value="v">Up</option>
                    </select>
                  </label>
                  <label title="Rows are taken in the order the source has them — largest first for a contribution or a hotspot list">
                    <span>Rows</span>{' '}
                    <NumberInput
                      min={1}
                      max={40}
                      style={{ width: '4.5em' }}
                      value={f.rows ?? 15}
                      onValue={(raw) => set(i, { rows: Math.max(1, Math.min(40, Number(raw) || 1)) })}
                    />
                  </label>
                  <label title="One bar per variant split by group, instead of one bar per group. Needs at least two variants — with one there is nothing to stack, and it draws as plain bars.">
                    <input
                      type="checkbox"
                      checked={Boolean(f.stacked)}
                      onChange={(e) =>
                        set(i, { stacked: e.target.checked, kind: e.target.checked ? 'stacked_bar' : 'bar' })
                      }
                    />
                    <span>Stacked</span>
                  </label>
                </>
              ) : null}

              <button
                className="btn sm"
                title="Remove this figure"
                onClick={() => onChange(figures.filter((_, n) => n !== i))}
              >
                ✕
              </button>
            </div>

            <input
              className="rsec-figcap"
              placeholder="Caption — left empty, the document writes a standard one"
              value={f.caption ?? ''}
              onChange={(e) => set(i, { caption: e.target.value.slice(0, 160) })}
            />

            {/* Said here rather than by hiding the option: a control that vanishes is one people go looking
                for, and the reason it cannot be drawn is a fact about the report, not about the chapter. */}
            {isComparison(f.kind) && !canCompare ? (
              <p className="rsec-findings" style={{ margin: '6px 0 0' }}>
                This report has one variant, so there is nothing to compare — the figure is left out of the
                document until a second subject is added.
              </p>
            ) : null}
            {radarTooFew ? (
              <p className="rsec-findings" style={{ margin: '6px 0 0' }}>
                A radar needs more than three indicators to be a shape rather than a line. This report has{' '}
                {indicatorCount}.
              </p>
            ) : null}
            {rowKind && f.source === 'subjects' ? (
              <p className="settings-hint">
                One bar per variant, scored on the report’s first indicator — the one the results are ordered
                by. There is nothing to pick a field from and nothing to cut off, so Plot and Rows do not
                apply.
              </p>
            ) : null}
            {f.stacked && !canCompare ? (
              <p className="settings-hint">
                With a single variant there is nothing to stack — it draws as plain bars, one per group.
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
