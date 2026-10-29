/**
 * The report figures, drawn from a data snapshot.
 *
 * The stored report and the short report draw the same charts from the same snapshot shape, so the
 * drawing lives here, out of views/Report.tsx, and both call it. Charts
 * are produced in the renderer, not in the backend — echarts and the colour tokens live here, so a
 * report figure is the same drawing as the one on screen — and travel back to the backend as SVG under
 * keys that name what each one shows (see `chartKey` below): `lcia:<method path>`,
 * `contribution:<dimension>|<method path>`, `summary:<method path>`, `section:<id>/<n>|…`, and the three
 * report-wide ones under their plain names (`heatmap`, `radar`, `system-model`).
 */
import { paletteColors } from '../../views/PalettePicker'
import { databaseReferences, methodFamilyInfo } from '../methodInfo'
import { figureInk } from '../reportColors'
import { indicatorLabel } from '../methods'
import {
  BAR_WIDTH,
  CONTRIBUTION_WIDTH,
  barOption,
  chartSvg,
  columnChartHeight,
  contributionPlotTop,
  groupedContributionOption,
  heatmapHeight,
  heatmapOption,
  radarHeight,
  radarOption,
  rowChartHeight,
  stackedContributionHeight,
  stackedContributionOption,
  type ContributionGroup,
  type FigureFonts
} from '../charts/reportFigures'
import { systemModelSvg, type SystemModelData } from '../charts/systemModel'

/** The slice of the render data snapshot the charts need. */
export interface ReportData {
  /** The system-model figure's data (`report_graph.system_model`), when a chapter asked for it. */
  system_model?: SystemModelData
  results: { method: string[]; method_label: string; unit: string; score: number }[]
  provenance?: { background?: string }
  /** Baseline plus each scenario/alternative, each with its own scores — what an LCIA figure compares. */
  subjects?: { label: string; results?: { method_label: string; score: number }[] }[]
  contribution?: { unit: string; groups: ContributionGroup[] }
  /** One breakdown per indicator, lead first — `contribution` above is the same as `contributions[0]`. */
  contributions?: ContributionView[]
  /** The lead indicator's breakdown per variant. Kept for a snapshot written before `contributions`. */
  contribution_subjects?: ContributionSubject[]
}

/** One variant's groups within a breakdown: the baseline, or a scenario. */
export interface ContributionSubject {
  label: string
  groups: ContributionGroup[]
}

/** One indicator's breakdown: its own groups, and the same for every variant the report compares. */
export interface ContributionView {
  /** Its position in the report's method list — the backend builds the cross-reference label from it; the chart key uses `method_label`. */
  index?: number
  method_label: string
  unit?: string
  groups?: ContributionGroup[]
  subjects?: ContributionSubject[]
}

/** One figure a chapter asks for, as the backend validated it. */
export interface FigureSpec {
  /** `bar` | `stacked_bar` plot a source's rows; `heatmap` | `radar` are built from subjects × indicators. */
  kind: string
  source: string
  value: string
  label: string
  caption?: string
  rows?: number
  /** Bars across the page or up it. */
  horizontal?: boolean
  /** A split drawn as one stack or as bars side by side. */
  stacked?: boolean
}

/** A chapter that asked for figures: its validated specs plus the id the chart files are keyed by. */
export interface ChapterFigure {
  id: string
  /** The chapter kind — `summary` carries a standard figure that no spec describes. */
  kind?: string
  /** The chapter's own list, in drawing order. */
  figures?: FigureSpec[]
  /** The writer's single proposal, drawn when the list is empty — a report written before the list existed. */
  figure?: FigureSpec
  /** Results chapter: "all" | "lead" | "none" — how many indicators get a bar chart of their own. */
  per_indicator_charts?: string | null
  /** System-model chapter: how the figure is coloured (`tag:<family>` | `share` | null) and labelled. */
  colour_by?: string | null
  edge_amounts?: boolean
}

// ---- chart keys -------------------------------------------------------------------------------------
// A chart is keyed by what it shows, never by its place in the method list: `contribution-1` used to be
// whichever indicator stood second, and after the list changed a data refresh put another indicator's
// chart under the old caption. The backend places each chart by the same key and derives its file name
// from it (report_model.chart_key / indicator_identity / section_chart_key) — these functions mirror
// those, character for character, and a key the backend does not rebuild is a chart it does not place.

/**
 * One component of a chart identity, with the delimiters it could be confused with escaped: `%` → `%25`,
 * `|` → `%7C`, and — where the slash separates components (a chapter from its figure's place) — `/` →
 * `%2F`. Without it `("tag:a|b", "c")` and `("tag:a", "b|c")` were one identity. Mirrors
 * report_model.key_part exactly.
 */
export function keyPart(value: string, slash = false): string {
  const text = value.split('%').join('%25').split('|').join('%7C')
  return slash ? text.split('/').join('%2F') : text
}

/** One indicator's breakdown in one dimension — the identity its contribution table carries too. */
export function indicatorIdentity(dimension: string, methodLabel: string): string {
  return `${keyPart(dimension)}|${keyPart(methodLabel)}`
}

/** `<kind>:<identity>` — `lcia:t / gwp / a`, `contribution-stacked:geo|t / gwp / a`, `summary:…`. */
export function chartKey(kind: string, identity: string): string {
  return `${kind}:${identity}`
}

/** What a spec that leaves `rows` out draws — the same default the drawing below uses. */
const SECTION_DEFAULT_ROWS = 15

/**
 * A chapter's own figure: the chapter, its place in the chapter's list (`null` for the writer's single
 * proposal, written `single` so it cannot meet an indexed one), and everything it draws — the fields and
 * settings of the spec, the report's own dimension for `contribution.groups` (the lead breakdown), and
 * for every row source the lead's method path. The heatmap and the radar span every indicator and depend
 * on none of it. Mirrors report_model.section_chart_key exactly.
 */
export function sectionChartKey(
  sectionId: string,
  index: number | null,
  spec: Partial<Pick<FigureSpec, 'kind' | 'source' | 'value' | 'label' | 'rows' | 'horizontal' | 'stacked'>>,
  leadMethod: string,
  dimension = ''
): string {
  const kind = spec.kind ?? ''
  const place = `${keyPart(sectionId, true)}/${index === null ? 'single' : index}`
  if (kind === 'heatmap' || kind === 'radar') return `section:${place}|${keyPart(kind)}`
  const source = spec.source ?? ''
  const parts = [
    kind,
    source,
    spec.label ?? '',
    spec.value ?? '',
    String(spec.rows ?? SECTION_DEFAULT_ROWS),
    spec.horizontal !== false ? 'h' : 'v',
    spec.stacked ? 'stacked' : '',
    source === 'contribution.groups' ? dimension : '',
    leadMethod
  ]
  return `section:${place}|` + parts.map((p) => keyPart(p)).join('|')
}

/** An impact-method family and where it is published — for the report's bibliography. */
export interface MethodReference {
  name: string
  url: string
  text: string
}

/** What `/sources` answers with — for a stored report and for the short report alike. */
export type SourcesSnapshot = {
  data: ReportData
  sections?: ChapterFigure[]
  options?: Record<string, unknown>
  language?: string
  palette?: string
  /** The three the report overrides by hand — they win over the set, here as on the page. */
  palette_colors?: { accent?: string; deep?: string; paper?: string }
  dark?: boolean
  fonts?: FigureFonts
  render_token?: string
}

/**
 * Every figure the document can carry, drawn from the snapshot's numbers, plus the method references
 * for the bibliography. `indLabels` is the indicator-name table over the whole catalogue (lib/methods),
 * so a chart axis says what the table and the chapter heading beside it say (V203).
 */
export async function figuresFromSnapshot(
  snapshot: SourcesSnapshot,
  indLabels: Parameters<typeof indicatorLabel>[1]
): Promise<{ figures: Record<string, string>; references: MethodReference[] }> {
  // Every figure below is drawn in the report's own colours — the set chosen under Appearance, with the
  // series colours derived from it. Resolved once per render rather than per chart.
  const pal = await paletteColors(snapshot.palette ?? '', snapshot.palette_colors)
  // …and on the paper the *theme* uses: everything that is not data (axis text, grid lines, cell borders)
  // flips for a dark theme, or the chart arrives with an axis nobody can read.
  const ink = figureInk(Boolean(snapshot.dark))
  // …and in the theme's own faces, so a chart is lettered like the page it lands on.
  const fonts = snapshot.fonts
  // …and with every number set in the REPORT's language. The app is English and stays English; a
  // figure, though, is part of the document, and its numbers have to read like the table beside
  // them — 41,3 in a German report, 41.3 in an English one (V187). Passed to each builder rather
  // than held anywhere: the same builders draw the same charts for the screen, in English.
  const lang = snapshot.language ?? 'en'
  // The reference table lives here, beside the "Method reference ↗" links the user already sees, so
  // the bibliography cites the same source the app does.
  const references: MethodReference[] = []
  // "a, b" when the model draws on two backgrounds (ecoinvent and BAFU) — each gets its entry.
  for (const db of databaseReferences(snapshot.data?.provenance?.background ?? '')) {
    if (db.url) references.push({ name: db.name, url: db.url, text: db.text })
  }
  for (const r of snapshot.data?.results ?? []) {
    const family = r.method?.[0]
    if (!family || references.some((x) => x.name === family)) continue
    const info = methodFamilyInfo(family)
    if (info?.url) references.push({ name: family, url: info.url, text: info.text })
  }
  const figures: Record<string, string> = {}
  // One chart per indicator, comparing the subjects. Indicators do not share a unit, so charting
  // them together put incomparable quantities on one axis; per indicator the axis means something.
  // With a single subject there is nothing to compare, so no chart is drawn — the table has the
  // number, and a lone bar is decoration.
  const results = snapshot.data?.results ?? []
  const subjects = snapshot.data?.subjects ?? []
  // How many of these the results chapter wants is its own setting (Edit → Results table and
  // charts): eleven indicators produced eleven charts of one matrix, in front of a heatmap and a
  // radar of the same matrix. Read here as well as in the backend so the ones that will not be
  // placed are not drawn either — each is an echarts render.
  // The most demanding results chapter decides: a report may hold several, each rendered by the
  // backend with its own setting, and reading only the first one starved a later chapter set to
  // "all" of every SVG.
  const perIndicatorSettings = (snapshot.sections ?? [])
    .filter((s) => s.kind === 'lcia')
    .map((s) => s.per_indicator_charts ?? 'all')
  const perIndicator = perIndicatorSettings.includes('all')
    ? 'all'
    : perIndicatorSettings.includes('lead')
      ? 'lead'
      : perIndicatorSettings.length
        ? 'none'
        : 'all'
  if (subjects.length > 1 && perIndicator !== 'none') {
    results.forEach((r, index) => {
      if (perIndicator === 'lead' && index > 0) return
      const label = r.method_label
      const values = subjects.map((s) => (s.results ?? []).find((x) => x.method_label === label)?.score ?? 0)
      const names = subjects.map((s) => s.label)
      const svg = chartSvg(
        barOption(names, values, r.unit ?? '', pal, true, ink, fonts, lang),
        BAR_WIDTH,
        // A row per variant as tall as its name's lines: nine names of three lines did not fit in 300.
        rowChartHeight(names, 300)
      )
      if (svg) figures[chartKey('lcia', label)] = svg
    })
  }
  // Comparison figures, when the report asked for them and the data can carry them. A radar or a
  // heatmap over a single subject compares nothing, and a radar needs enough axes to be a shape rather
  // than a line — the checkboxes are only offered when those hold.
  const wanted = (snapshot.options?.figures ?? {}) as {
    heatmap?: boolean
    radar?: boolean
    stacked?: boolean
  }
  const indicators = results.map((r) => r.method_label)
  const shortLabels = results.map((r) => indicatorLabel(r.method, indLabels) || r.method_label)
  if (subjects.length > 1 && indicators.length) {
    if (wanted.heatmap) {
      const svg = chartSvg(
        heatmapOption(subjects, indicators, shortLabels, pal, ink, fonts, lang),
        760,
        heatmapHeight(
          subjects.map((s) => s.label),
          shortLabels
        )
      )
      if (svg) figures.heatmap = svg
    }
    if (wanted.radar && indicators.length > 3) {
      const svg = chartSvg(
        radarOption(subjects, indicators, shortLabels, pal, ink, fonts),
        700,
        radarHeight(subjects.map((s) => s.label))
      )
      if (svg) figures.radar = svg
    }
  }
  // One contribution chart per indicator: baseline and every scenario together where the report
  // compares variants, plain bars where it does not. Per indicator rather than one chart for the
  // leading one, because indicators do not share a unit — a single axis across them means nothing,
  // and a chapter that breaks down three indicators needs three pictures.
  //
  // Keys name the dimension and the indicator (`indicatorIdentity`), the same identity the chapter's
  // table carries, so after a refresh the two are there together or missing together.
  const dims = (snapshot.data as { breakdown_dimensions?: string[] } | undefined)?.breakdown_dimensions ?? []
  const contributions =
    (snapshot.data as { contributions?: ContributionView[] } | undefined)?.contributions ?? []
  const views: ContributionView[] = contributions.length
    ? contributions
    : // A snapshot from before per-indicator existed: draw the one it has, with no method path in its key.
      [
        {
          method_label: '',
          unit: snapshot.data?.contribution?.unit ?? '',
          groups: snapshot.data?.contribution?.groups ?? [],
          subjects:
            (snapshot.data as { contribution_subjects?: ContributionSubject[] } | undefined)
              ?.contribution_subjects ?? []
        }
      ]
  // The leading indicator's variants, for a *chapter's own* stacked figure further down: that spec
  // names a row source and has no indicator of its own, so it stacks what the report leads with.
  const perSubject = views[0]?.subjects ?? []
  // Indicators EVERY contribution chapter leaves out are not drawn: an SVG nothing embeds is paid
  // for and thrown away, and these are the most expensive charts the report makes. Every chapter,
  // not any — the backend's rule (report_pipeline): a chapter that still shows the indicator embeds
  // the figure, and the union of all chapters' lists took it away from that chapter.
  const hiddenLists = (snapshot.sections ?? [])
    .filter((sec) => sec.kind === 'contribution')
    .map((sec) => new Set((sec as { hidden_indicators?: string[] }).hidden_indicators ?? []))
  const hiddenIndicators = new Set(
    hiddenLists.length
      ? [...hiddenLists[0]].filter((label) => hiddenLists.every((set) => set.has(label)))
      : []
  )
  views.forEach((view) => {
    if (view.method_label && hiddenIndicators.has(view.method_label)) return
    const identity = indicatorIdentity(dims[0] ?? '', view.method_label ?? '')
    const perSubject = view.subjects ?? []
    const unit = view.unit ?? ''
    if (wanted.stacked && perSubject.length > 1) {
      // Stacked replaces the other two rather than joining them: the same numbers drawn twice is
      // noise, and the report asked for this shape.
      //
      // Two variants at least. A single stack can only be read for its total — the segment heights
      // have to be eyeballed against each other, because none of them starts at the axis. A bar per
      // group puts every group on the axis, so with one variant that is the better chart and the
      // option is offered but not usable.
      const phases = new Set(perSubject.flatMap((b) => b.groups.map((g) => g.key)))
      if (phases.size) {
        const svg = chartSvg(
          stackedContributionOption(perSubject, unit, pal, true, false, ink, fonts, lang),
          CONTRIBUTION_WIDTH,
          stackedContributionHeight(perSubject)
        )
        if (svg) figures[chartKey('contribution-stacked', identity)] = svg
      }
    } else if (perSubject.length > 1) {
      const svg = chartSvg(
        groupedContributionOption(perSubject, unit, pal, ink, fonts, lang),
        CONTRIBUTION_WIDTH,
        // One category more than the groups: the totals. Then the legend of the variants over it.
        92 + (perSubject[0].groups.length + 1) * 26 + contributionPlotTop(perSubject.map((b) => b.label))
      )
      if (svg) figures[chartKey('contribution-grouped', identity)] = svg
    } else if (view.groups?.length) {
      // The printed name, as the table beside it prints it — the key is the untranslated group name.
      const names = view.groups.map((g) => g.label || g.key)
      const svg = chartSvg(
        barOption(
          names,
          view.groups.map((g) => g.impact),
          unit,
          pal,
          true,
          ink,
          fonts,
          lang
        ),
        BAR_WIDTH,
        rowChartHeight(names, 300)
      )
      if (svg) figures[chartKey('contribution', identity)] = svg
    }
  })
  // The executive summary's one standard figure: every variant side by side for the leading
  // indicator — typically climate change, since that is the indicator a summary is read for. Only
  // with something to compare: a chart of one bar is decoration, and the author asked for none there.
  if (subjects.length > 1 && snapshot.sections?.some((s) => s.kind === 'summary') && results[0]) {
    const svg = chartSvg(
      barOption(
        subjects.map((s) => s.label),
        subjects.map(
          (s) => (s.results ?? []).find((r) => r.method_label === results[0].method_label)?.score ?? 0
        ),
        results[0].unit,
        pal,
        true,
        ink,
        fonts,
        lang
      ),
      BAR_WIDTH,
      rowChartHeight(
        subjects.map((s) => s.label),
        80 + subjects.length * 52
      )
    )
    // Keyed by that indicator: a refresh whose lead is another one leaves a gap under the caption.
    if (svg) figures[chartKey('summary', results[0].method_label)] = svg
  }

  // Figures individual chapters asked for, in the order they list them. Every spec was validated in the
  // backend against a whitelist of sources and numeric fields, so here it is only a lookup and a draw —
  // no model output is interpreted, which is why a "silent semantic error" cannot arise.
  //
  // The key carries the chapter, the index and what the figure plots (`sectionChartKey`), and the backend
  // places the drawings by the same key, so reordering a chapter's figures reorders the drawings with
  // them and a refresh never slips one under another's caption. A chapter whose list is empty falls
  // back to the writer's single proposal, which is what a report written before the list existed
  // carries.
  const leadLabel = results[0]?.method_label ?? ''
  for (const section of snapshot.sections ?? []) {
    const specs: FigureSpec[] = section.figures?.length
      ? section.figures
      : section.figure
        ? [section.figure]
        : []
    const single = !section.figures?.length
    specs.forEach((spec, i) => {
      const key = sectionChartKey(section.id, single ? null : i, spec, leadLabel, dims[0] ?? '')
      // Built from the report's comparison rather than from a row source — the same two drawings the
      // report can carry centrally, here as a chapter's own.
      if (spec.kind === 'heatmap' || spec.kind === 'radar') {
        if (subjects.length < 2 || !indicators.length) return
        // Same threshold as the central checkbox above: with exactly three axes a radar is a
        // triangle, not a profile — this guard read `< 3` and drew the triangle the other refused.
        if (spec.kind === 'radar' && indicators.length <= 3) return
        const svg =
          spec.kind === 'heatmap'
            ? chartSvg(
                heatmapOption(subjects, indicators, shortLabels, pal, ink, fonts, lang),
                760,
                heatmapHeight(
                  subjects.map((s) => s.label),
                  shortLabels
                )
              )
            : chartSvg(
                radarOption(subjects, indicators, shortLabels, pal, ink, fonts),
                700,
                radarHeight(subjects.map((s) => s.label))
              )
        if (svg) figures[key] = svg
        return
      }
      // "Variants (leading indicator)" has no numeric column of its own — a subject's score lives in
      // its own results list, which is why the editor offers no field to plot. The generic row path
      // below therefore read `r[""]`, and every bar came out zero: a chart the editor offered, the
      // backend accepted and the document printed as a row of empty bars. Same shape as the central
      // per-indicator chart above.
      if (spec.source === 'subjects') {
        const lead = results[0]
        if (!lead || subjects.length < 1) return
        const svg = chartSvg(
          barOption(
            subjects.map((s) => s.label),
            subjects.map(
              (s) => (s.results ?? []).find((x) => x.method_label === lead.method_label)?.score ?? 0
            ),
            lead.unit ?? '',
            pal,
            spec.horizontal !== false,
            ink,
            fonts,
            lang
          ),
          BAR_WIDTH,
          spec.horizontal !== false
            ? rowChartHeight(subjects.map((s) => s.label))
            : columnChartHeight(subjects.map((s) => s.label))
        )
        if (svg) figures[key] = svg
        return
      }
      const rows = (spec.source.split('.').reduce<any>((node, part) => node?.[part], snapshot.data) ??
        []) as Array<Record<string, unknown>>
      const shown = rows.slice(0, spec.rows ?? SECTION_DEFAULT_ROWS)
      if (!shown.length) return
      const horizontal = spec.horizontal !== false
      const axis = spec.value === 'share_percent' ? '%' : (snapshot.data?.contribution?.unit ?? '')
      // A stacked bar needs a second dimension to stack, and the one the report has is the variants.
      // With a single subject there is nothing to stack, so it draws as plain bars rather than as one
      // block of colour — the honest fallback, and the reason the editor says so beside the switch.
      // And only the contribution groups' impacts stack: the variants' stack IS that source, so a
      // stacked figure of the elementary flows or of the shares drew the groups' impacts under the
      // other source's axis — those fall back to plain bars of what was asked for.
      const stackable =
        spec.stacked && spec.source === 'contribution.groups' && spec.value !== 'share_percent'
      const svg =
        stackable && perSubject && perSubject.length > 1
          ? chartSvg(
              stackedContributionOption(perSubject, axis, pal, true, horizontal, ink, fonts, lang),
              CONTRIBUTION_WIDTH,
              stackedContributionHeight(perSubject, horizontal)
            )
          : chartSvg(
              barOption(
                shown.map((r) => String(r[spec.label] ?? '')),
                shown.map((r) => Number(r[spec.value] ?? 0)),
                axis,
                pal,
                horizontal,
                ink,
                fonts,
                lang
              ),
              BAR_WIDTH,
              (horizontal ? rowChartHeight : columnChartHeight)(shown.map((r) => String(r[spec.label] ?? '')))
            )
      if (svg) figures[key] = svg
    })
  }
  // A contribution chapter split by a further dimension (the short report's breakdown list): the
  // same three shapes, keyed by that dimension — see report_render._build_contribution for the rule,
  // mirrored here.
  const byDim =
    (snapshot.data as { contributions_by_dimension?: Record<string, ContributionView[]> } | undefined)
      ?.contributions_by_dimension ?? {}
  dims.slice(1).forEach((dim) => {
    for (const view of byDim[dim] ?? []) {
      if (view.method_label && hiddenIndicators.has(view.method_label)) continue
      const identity = indicatorIdentity(dim, view.method_label ?? '')
      const perSubject = view.subjects ?? []
      const unit = view.unit ?? ''
      if (wanted.stacked && perSubject.length > 1) {
        const phases = new Set(perSubject.flatMap((b) => b.groups.map((g) => g.key)))
        if (!phases.size) continue
        const svg = chartSvg(
          stackedContributionOption(perSubject, unit, pal, true, false, ink, fonts, lang),
          CONTRIBUTION_WIDTH,
          stackedContributionHeight(perSubject)
        )
        if (svg) figures[chartKey('contribution-stacked', identity)] = svg
      } else if (perSubject.length > 1) {
        const svg = chartSvg(
          groupedContributionOption(perSubject, unit, pal, ink, fonts, lang),
          CONTRIBUTION_WIDTH,
          92 + (perSubject[0].groups.length + 1) * 26 + contributionPlotTop(perSubject.map((b) => b.label))
        )
        if (svg) figures[chartKey('contribution-grouped', identity)] = svg
      } else if (view.groups?.length) {
        const names = view.groups.map((g) => g.label || g.key)
        const svg = chartSvg(
          barOption(
            names,
            view.groups.map((g) => g.impact),
            unit,
            pal,
            true,
            ink,
            fonts,
            lang
          ),
          BAR_WIDTH,
          rowChartHeight(names, 300)
        )
        if (svg) figures[chartKey('contribution', identity)] = svg
      }
    }
  })

  // The system model, when the report carries the chapter: foreground processes, their links and the
  // first background tier, laid out deterministically (dagre) and drawn as SVG — see systemModel.ts.
  const systemSection = (snapshot.sections ?? []).find((s) => s.kind === 'system_model')
  if (systemSection && snapshot.data?.system_model?.nodes?.length) {
    const svg = systemModelSvg(
      snapshot.data.system_model,
      {
        colourBy: systemSection.colour_by ?? null,
        edgeAmounts: Boolean(systemSection.edge_amounts),
        lang
      },
      pal,
      ink,
      fonts
    )
    if (svg) figures['system-model'] = svg
  }
  return { figures, references }
}
