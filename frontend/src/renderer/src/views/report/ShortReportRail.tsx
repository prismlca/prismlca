import IndicatorPicker, { type PickerMethod } from '../../components/IndicatorPicker'
import { AccordionGroup, useSingleOpen } from '../../components/Accordion'
import PalettePicker, { resolvePalette, usePalettes } from '../PalettePicker'
import ThemeGallery, { type Theme } from '../ThemeGallery'
import { NumberInput } from '../../components/NumberInput'
import ShortHeadGroup, { type ShortHead } from './ShortHeadGroup'

/**
 * Everything the short report is made from, beside the reference process and the indicators (those two
 * keep their own persisted keys, shared with the page). Mirrors `report_short.ShortSettings` field for
 * field, minus the render-request half that travels with each call.
 */
export interface ShortSettings {
  amount: number
  lang: string
  template: string
  palette: string
  palette_colors: { accent?: string; deep?: string; paper?: string }
  /** Variants beside the reference: scenarios of the same process. Held with the model, not app-wide like
   *  the rest — see `useShortSettings`. */
  compare: { scenario: string }[]
  /** Contribution dimensions — `tag:<family>`; the first is the report's own breakdown. */
  breakdowns: string[]
  /** Chapter kind → on/off; a kind not named takes the backend's default. */
  contents: Record<string, boolean>
  heatmap: boolean
  radar: boolean
  stacked: boolean
  per_indicator_charts: 'all' | 'lead' | 'none'
  hotspots: boolean
  background_tier: boolean
  per_process: number
  colour_by: string
  edge_amounts: boolean
}

export const DEFAULT_SHORT_SETTINGS: ShortSettings = {
  amount: 1,
  lang: 'en',
  template: '',
  palette: '',
  palette_colors: {},
  compare: [],
  breakdowns: [],
  contents: {},
  heatmap: false,
  radar: false,
  stacked: false,
  per_indicator_charts: 'all',
  hotspots: true,
  background_tier: true,
  per_process: 4,
  colour_by: '',
  edge_amounts: false
}

/** The chapters a short report can carry, in reading order, with the backend's default for each. Mirrors
 *  `report_short.DEFAULT_CONTENTS`; the label is what the PDF's heading says in English. No abbreviations
 *  chapter: resolving acronyms is a model's job, and this report has none. */
export const SHORT_CHAPTERS: { kind: string; label: string; on: boolean; hint?: string }[] = [
  { kind: 'goal_scope', label: 'Goal & scope', on: true },
  {
    kind: 'system_model',
    label: 'System model',
    on: true,
    hint: 'The process graph: your processes and their direct background inputs'
  },
  {
    kind: 'inventory',
    label: 'Life cycle inventory',
    on: true,
    hint: 'The processes and the datasets they link to'
  },
  { kind: 'methods', label: 'Methods', on: true },
  { kind: 'lcia', label: 'Results', on: true },
  {
    kind: 'contribution',
    label: 'Contribution',
    on: true,
    hint: 'Needs a breakdown under Breakdown & charts'
  },
  {
    kind: 'interpretation_checks',
    label: 'Interpretation checks',
    on: true,
    hint: 'Completeness, sensitivity, consistency (ISO 14044 §4.5)'
  },
  {
    kind: 'limitations',
    label: 'Limitations',
    on: true,
    hint: 'What the study declares, and what the report can check is absent'
  },
  {
    kind: 'datasets',
    label: 'Background datasets',
    on: false,
    hint: 'A chapter of its own for the datasets table — the inventory then keeps only the processes'
  },
  {
    kind: 'appendix',
    label: 'Annex',
    on: false,
    hint: 'Parameters, scenarios and the largest elementary flows'
  },
  { kind: 'references', label: 'References', on: true },
  { kind: 'provenance', label: 'Reproducibility', on: true }
]

export function chapterOn(settings: ShortSettings, kind: string): boolean {
  const own = settings.contents[kind]
  if (own !== undefined) return own
  return SHORT_CHAPTERS.find((c) => c.kind === kind)?.on ?? true
}

/**
 * The short report's rail: five groups in the full report's accordion idiom — subject, indicators,
 * breakdown & charts, contents, appearance — every setting a checkbox or a select, every change applied
 * at once (no Save button, per the house rule), and Generate / Save PDF pinned at the foot like the full
 * report's document bar. The document is not stored: it is a look at where the model stands, and these settings
 * persist in the app — except the title and subtitle, which name one study and so live with the model.
 */
export default function ShortReportRail({
  code,
  setCode,
  acts,
  scenarios,
  families,
  methods,
  picked,
  onPicked,
  settings,
  update,
  head,
  onHead,
  templates,
  onTemplatesChanged,
  busy,
  onGenerate,
  onSavePdf,
  notices
}: {
  code: string
  setCode: (code: string) => void
  acts: { code: string; name: string }[]
  scenarios: { id: string; name: string }[]
  /** Tag families in use in this model — the breakdown dimensions on offer. */
  families: string[]
  methods: PickerMethod[]
  picked: string[]
  onPicked: (next: string[]) => void
  settings: ShortSettings
  update: (patch: Partial<ShortSettings>) => void
  /** Title and subtitle — the model's own, from its view (see `ShortHeadGroup`). */
  head: ShortHead
  onHead: (next: ShortHead) => void
  templates: Theme[]
  onTemplatesChanged: () => void | Promise<void>
  busy: boolean
  onGenerate: () => void
  onSavePdf: () => void
  notices?: React.ReactNode
}): JSX.Element {
  const [grp] = useSingleOpen('prism.report.short.grp', 'subject')
  const { list: paletteList } = usePalettes()
  const variants = 1 + settings.compare.length
  const canRun = !busy && Boolean(code) && picked.length > 0
  const toggleCompare = (scenario: string, on: boolean): void => {
    const rest = settings.compare.filter((x) => x.scenario !== scenario)
    update({ compare: on ? [...rest, { scenario }] : rest })
  }
  const toggleBreakdown = (dim: string, on: boolean): void => {
    const rest = settings.breakdowns.filter((d) => d !== dim)
    update({ breakdowns: on ? [...rest, dim] : rest })
  }
  const toggleChapter = (kind: string, on: boolean): void =>
    update({ contents: { ...settings.contents, [kind]: on } })
  const refName = acts.find((a) => a.code === code)?.name ?? 'nothing yet'
  const chaptersOn = SHORT_CHAPTERS.filter((c) => chapterOn(settings, c.kind)).length
  const themeLabel =
    templates.find((t) => t.name === settings.template)?.label ??
    templates.find((t) => t.builtin)?.label ??
    ''
  const shownPalette = resolvePalette(paletteList, settings.palette)
  const paletteLabel = shownPalette?.label ?? ''

  return (
    <>
      <p className="settings-hint">
        Deterministic and unstored — a quick look at where the model stands. Every chapter is built from the
        model&apos;s data; no assistant writes anything.
      </p>

      {/* One column without the rail's 10px flex gap between groups: the rules of neighbouring group heads
          sat 10px apart and every head but the last read taller than it was. Same wrapper
          as the full report's panel. */}
      <div className="rsec">
        <ShortHeadGroup
          head={head}
          onHead={onHead}
          lang={settings.lang}
          onLang={(lang) => update({ lang })}
          refName={refName}
          grp={grp('head')}
        />

        <AccordionGroup
          title="Subject"
          summary={`${refName}${variants > 1 ? ` · ${variants} variants` : ''}`}
          {...grp('subject')}
        >
          <label className="settings-field">
            <span>Reference process</span>
            <select value={code} onChange={(e) => setCode(e.target.value)}>
              {acts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>Amount (functional unit)</span>
            <NumberInput
              min={0}
              step="any"
              value={settings.amount}
              onValue={(raw) => update({ amount: Number(raw) || 1 })}
            />
          </label>
          {/* Ticking a scenario adds it as a variant beside the reference — which is what turns the report
            into a comparison: the matrix, the heatmap, the radar, the grouped contribution chart and the
            sensitivity check all appear from the second variant on. Scenarios only: a variant is the
            reference process under other parameter values, so a model without scenarios has nothing to
            compare and gets no block at all. */}
          {scenarios.length ? (
            <div className="rsec-figopts rsec-figlist">
              <span className="modal-h">Compare with</span>
              {scenarios.map((sc) => (
                <label key={sc.id}>
                  <input
                    type="checkbox"
                    checked={settings.compare.some((x) => x.scenario === sc.id)}
                    onChange={(e) => toggleCompare(sc.id, e.target.checked)}
                  />
                  <span>{sc.name}</span>
                </label>
              ))}
            </div>
          ) : null}
        </AccordionGroup>

        <AccordionGroup title="Indicators" summary={`${picked.length} indicators`} {...grp('indicators')}>
          <IndicatorPicker methods={methods} picked={picked} onChange={onPicked} />
          {!picked.length ? <p className="settings-hint">Pick at least one impact indicator.</p> : null}
        </AccordionGroup>

        <AccordionGroup
          title="Breakdown & charts"
          summary={
            settings.breakdowns.length
              ? settings.breakdowns.map((d) => d.replace(/^tag:/, '')).join(', ')
              : 'no breakdown'
          }
          {...grp('charts')}
        >
          <div className="sub-label">Break the contribution down by</div>
          <div className="rsec-figopts rsec-figlist">
            {families.map((f) => (
              <label key={f}>
                <input
                  type="checkbox"
                  checked={settings.breakdowns.includes(`tag:${f}`)}
                  onChange={(e) => toggleBreakdown(`tag:${f}`, e.target.checked)}
                />
                <span>{f}</span>
              </label>
            ))}
            {!families.length ? (
              <span className="settings-hint">
                Tag the processes with a family to break the results down by it.
              </span>
            ) : null}
          </div>
          {settings.breakdowns.length ? (
            <label className="settings-field">
              <span>Contribution chart</span>
              <span
                className="seg"
                title={
                  variants > 1
                    ? undefined
                    : 'Stacking needs a second variant. With one, a bar per group is easier to read.'
                }
              >
                {(
                  [
                    ['Grouped', false],
                    ['Stacked', true]
                  ] as const
                ).map(([label, on]) => (
                  <button
                    key={label}
                    className={`seg-btn${(settings.stacked && variants > 1) === on ? ' on' : ''}`}
                    disabled={on && variants < 2}
                    onClick={() => update({ stacked: on })}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </label>
          ) : null}
          <label className="settings-field">
            <span>Per-indicator charts</span>
            <span
              className="seg"
              title="How many indicators get a bar chart of their own in the results chapter"
            >
              {(
                [
                  ['All', 'all'],
                  ['Lead', 'lead'],
                  ['None', 'none']
                ] as const
              ).map(([label, value]) => (
                <button
                  key={value}
                  className={`seg-btn${settings.per_indicator_charts === value ? ' on' : ''}`}
                  disabled={variants < 2}
                  title={
                    variants < 2
                      ? 'Per-indicator charts compare variants — tick a scenario under Subject'
                      : undefined
                  }
                  onClick={() => update({ per_indicator_charts: value })}
                >
                  {label}
                </button>
              ))}
            </span>
          </label>
          <div className="rsec-figopts rsec-figlist">
            <label
              title={
                variants > 1
                  ? 'Every indicator side by side, as a share of the highest value in its row'
                  : 'Needs a second variant'
              }
            >
              <input
                type="checkbox"
                disabled={variants < 2}
                checked={settings.heatmap && variants > 1}
                onChange={(e) => update({ heatmap: e.target.checked })}
              />
              <span>Heatmap of every indicator</span>
            </label>
            <label
              title={
                variants < 2
                  ? 'Needs a second variant'
                  : picked.length > 3
                    ? 'One closed line per variant across the indicator axes'
                    : 'Needs more than three indicators — with fewer, a radar is a triangle rather than a profile'
              }
            >
              <input
                type="checkbox"
                disabled={variants < 2 || picked.length <= 3}
                checked={settings.radar && variants > 1 && picked.length > 3}
                onChange={(e) => update({ radar: e.target.checked })}
              />
              <span>Radar across the indicators</span>
            </label>
            <label title="Under each breakdown: the background datasets with the largest direct contribution">
              <input
                type="checkbox"
                disabled={!settings.breakdowns.length}
                checked={settings.hotspots}
                onChange={(e) => update({ hotspots: e.target.checked })}
              />
              <span>Hotspot tables</span>
            </label>
          </div>
        </AccordionGroup>

        <AccordionGroup
          title="Contents"
          summary={`${chaptersOn} of ${SHORT_CHAPTERS.length} chapters`}
          {...grp('contents')}
        >
          <div className="rsec-figopts rsec-figlist">
            {SHORT_CHAPTERS.map((c) => (
              <label key={c.kind} title={c.hint}>
                <input
                  type="checkbox"
                  checked={chapterOn(settings, c.kind)}
                  disabled={c.kind === 'contribution' && !settings.breakdowns.length}
                  onChange={(e) => toggleChapter(c.kind, e.target.checked)}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
          {chapterOn(settings, 'system_model') ? (
            <>
              <div className="sub-label">System model figure</div>
              <div className="rsec-figopts rsec-figlist">
                <label title="Draw the datasets your processes link to directly, muted, beside them">
                  <input
                    type="checkbox"
                    checked={settings.background_tier}
                    onChange={(e) => update({ background_tier: e.target.checked })}
                  />
                  <span>First background tier</span>
                </label>
                <label title="Print each link's amount and unit beside the arrow">
                  <input
                    type="checkbox"
                    checked={settings.edge_amounts}
                    onChange={(e) => update({ edge_amounts: e.target.checked })}
                  />
                  <span>Amounts on the links</span>
                </label>
              </div>
              {settings.background_tier ? (
                <label
                  className="settings-field"
                  title="The largest inputs by their share of the leading indicator; two or more beyond that fold into one node per process"
                >
                  <span>Datasets per process</span>
                  <NumberInput
                    min={0}
                    max={20}
                    step={1}
                    value={settings.per_process}
                    onValue={(raw) => update({ per_process: Math.max(0, Math.min(20, Number(raw) || 0)) })}
                  />
                </label>
              ) : null}
              <label className="settings-field">
                <span>Colour processes by</span>
                <select value={settings.colour_by} onChange={(e) => update({ colour_by: e.target.value })}>
                  <option value="">Accent colour</option>
                  <option value="share">Share of the leading indicator</option>
                  {families.map((f) => (
                    <option key={f} value={`tag:${f}`}>
                      Tag family: {f}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </AccordionGroup>

        <AccordionGroup
          title="Appearance"
          summary={[paletteLabel, themeLabel].filter(Boolean).join(' · ')}
          {...grp('appearance')}
        >
          <PalettePicker
            selected={settings.palette}
            onSelect={(id) => update({ palette: id })}
            colors={settings.palette_colors}
            onColors={(next) => update({ palette_colors: next })}
          />
          <div className="sub-label">Theme</div>
          <ThemeGallery
            themes={templates}
            // The set it is typeset in — a deleted set of your own falls back, and the covers with it.
            palette={shownPalette?.id ?? settings.palette}
            colors={settings.palette_colors}
            selected={settings.template || templates.find((t) => t.builtin)?.name || ''}
            onSelect={(name) => update({ template: name })}
            onChanged={onTemplatesChanged}
          />
        </AccordionGroup>

        {/* Pinned to the rail's foot like the full report's document bar, so the two verbs of this page never
          scroll away — and never sit flush on the rail's bottom edge either. */}
        <div className="rsec-dock">
          <div className="rsec-foot">
            <div className="r">
              <button className="btn sm primary" disabled={!canRun} onClick={onGenerate}>
                {busy ? 'Generating…' : 'Generate'}
              </button>
              <button className="btn sm" disabled={!canRun} onClick={onSavePdf}>
                Save PDF
              </button>
            </div>
            {notices ? <div className="rsec-note">{notices}</div> : null}
          </div>
        </div>
      </div>
    </>
  )
}
