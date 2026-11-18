/**
 * The PARAMETERS section of the review dossier: the model's parameters with their values, units and the
 * modeller's note on each figure.
 *
 * The formulas stand at the exchanges, but the values behind them and where those values come from did not:
 * a shelving model without a research log named its retailer's figure only in the comment of `m_regal_gesamt`,
 * and the reviewer could not tell a measured mass from a guess. Entered values come first — they are the
 * study's assumptions; the computed ones follow, with their formulas, and give way first when the section is
 * long. What does not fit is counted, and named for the GAPS line.
 */

/** The section stays below this — it is read beside the process list, which is the larger part. */
const SECTION_CHARS = 6_000
/** The modeller's note on a figure, cut here: the source and the caveat come first in practice. */
const COMMENT_CHARS = 200

const HEAD =
  'PARAMETERS (entered values first, then those computed by a formula; after "—" the modeller\'s note on ' +
  'the figure, cut at 200 characters): the exchange formulas above use these names.'

const value = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '?'

function line(p: any): string {
  const unit = p?.unit ? ` ${p.unit}` : ''
  const formula = p?.formula ? ` = ${p.formula}` : ''
  const note = String(p?.description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const shown = note.length > COMMENT_CHARS ? `${note.slice(0, COMMENT_CHARS).trimEnd()}…` : note
  return `- ${p?.name}${formula} = ${value(p?.amount)}${unit}${shown ? ` — ${shown}` : ''}`
}

const byName = (a: any, b: any): number =>
  String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'en', { sensitivity: 'base' })

/** The section and what it left out (for GAPS), or '' with no gap when the model has no parameters. */
export function paramsSection(params: unknown): { text: string; gaps: string[] } {
  const all: any[] = Array.isArray(params) ? params.filter((p) => p && p.name) : []
  if (!all.length) return { text: '', gaps: [] }
  const entered = all.filter((p) => !p.formula).sort(byName)
  const computed = all.filter((p) => p.formula).sort(byName)
  const lines: string[] = [HEAD]
  let size = HEAD.length
  let shown = 0
  // Room for the closing count, so the section never overruns while saying what it left out.
  const budget = SECTION_CHARS - 200
  for (const p of [...entered, ...computed]) {
    const l = line(p)
    if (size + 1 + l.length > budget) break
    lines.push(l)
    size += 1 + l.length
    shown++
  }
  const rest = [...entered, ...computed].slice(shown)
  if (!rest.length) return { text: lines.join('\n'), gaps: [] }
  const restEntered = rest.filter((p) => !p.formula).length
  const what = `${rest.length} more not listed for length (${restEntered} entered, ${rest.length - restEntered} computed)`
  lines.push(`(+${what})`)
  return { text: lines.join('\n'), gaps: [`parameters: ${what}`] }
}
