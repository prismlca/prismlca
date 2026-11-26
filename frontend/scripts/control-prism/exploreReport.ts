/**
 * The report of an exploring session (report.md beside the runs' folders): per run where it went and what it
 * found, findings first, then what the runs reached together. Pure: it renders the records `exploreRun.ts` made.
 */
import type { RunRecord } from './exploreRun'
import type { Episode } from './exploreTrace'

export interface Finding {
  run: string
  source: 'property' | 'backend log' | 'console'
  title: string
  lines: string[]
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
/** The pages a run reached; "(none)" is the start, before the navigation is there. */
const pagesOf = (d: RunRecord['digest']): string[] =>
  (d?.pages ?? []).map((p) => p.page).filter((p) => p !== '(none)')
const pct = (a: number, b: number): string => (b > 0 ? `${((a * 100) / b).toFixed(1)} %` : '—')

function place(e: Episode): string {
  const w = e.where
  if (!w) return 'state without a place'
  return [
    w.page ? `page ${w.page}` : 'no page',
    w.dialog ? `dialog "${w.dialog}"` : null,
    w.section ? `section "${w.section}"` : null
  ]
    .filter(Boolean)
    .join(', ')
}

/** What a run found: its properties' episodes, the backend's unhandled errors, and console errors the
 *  properties did not report (those logged while the session was being prepared). */
export function findingsOf(r: RunRecord): Finding[] {
  const out: Finding[] = []
  for (const v of r.digest?.violations ?? []) {
    const lines = v.shown.slice(0, 3).map((e) => {
      const shot = r.screenshots[`${v.property}@${e.first}`]
      return `at ${clock(e.at)}, state ${e.first} (${place(e)}), after \`${e.action}\`: ${e.detail}${shot ? ` — [screenshot](${shot})` : ''}`
    })
    if (v.property === 'restAfterInput' && r.digest!.restBusyFunctions.length > 0)
      lines.push(
        'ran while nothing was put in (in ≥ 80 % of the busy windows; callbacks first, then hooks, then components): ' +
          r.digest!.restBusyFunctions.join(', ')
      )
    out.push({ run: r.session, source: 'property', title: `${v.property} — ${v.episodes} episode(s)`, lines })
  }
  for (const g of r.backend.groups) {
    out.push({
      run: r.session,
      source: 'backend log',
      title: `Unhandled error ${g.exception} — ×${g.count}`,
      lines: [
        `${g.where ? `at ${g.where}; ` : ''}first at app.log line ${g.firstLine}; tracebacks in backend-unhandled.txt`
      ]
    })
  }
  const consoleSeen = (r.digest?.violations ?? []).some((v) => v.property === 'noConsoleErrors')
  if ((r.consoleErrors ?? 0) > 0 && !consoleSeen) {
    out.push({
      run: r.session,
      source: 'console',
      title: `${r.consoleErrors} console error(s) outside the Bombadil run`,
      lines: ['see console-all.txt and console-prep.txt']
    })
  }
  return out
}

export function runLines(r: RunRecord, folder: string): string[] {
  const d = r.digest
  const lines: string[] = []
  const b = r.bombadil
  lines.push(
    `- **Outcome:** ${r.outcome === 'complete' ? 'complete' : `**${r.outcome.toUpperCase()}**`}` +
      (b ? ` — Bombadil exit ${b.exit} after ${b.seconds} s` : '') +
      (r.why ? `; ${r.why}` : '')
  )
  if (d) {
    lines.push(
      `- **Reached:** ${d.states} states in ${clock(d.seconds)}; ${pagesOf(d).length} pages (` +
        d.pages.map((p) => `${p.page} ${p.share} %`).join(', ') +
        `); ${d.dialogTypes.length} dialog types, ${d.sections.length} sections` +
        (d.documents > 2 ? `; **${d.documents} documents** — the window loaded more than once` : '')
    )
    if (d.coverage)
      lines.push(
        `- **Coverage:** ${pct(d.coverage.hit, d.coverage.total)} of ${d.coverage.total} blocks; ${d.coverage.named} named functions`
      )
    const verdicts = Object.entries(d.rest.verdicts)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')
    lines.push(`- **Rest observations:** ${d.rest.observations}${verdicts ? ` (${verdicts})` : ''}`)
    const loading = Object.entries(d.loading)
      .map(
        ([k, c]) =>
          `${k}: ${c.began} began, ${c.ended} ended in place, ${c.left} by leaving, ${c.open} open, longest ${c.maxSeconds} s`
      )
      .join('; ')
    if (loading) lines.push(`- **Loading:** ${loading}`)
    lines.push(`- **Dialog types:** ${d.dialogTypes.join(', ') || 'none'}`)
  }
  lines.push(
    `- **Sealed:** ${r.refused.count} attempt(s) refused or cancelled` +
      (r.refused.count
        ? ` (${Object.entries(r.refused.byKind)
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')}); most often: ${r.refused.targets.join(', ')}`
        : '')
  )
  lines.push(
    `- **Console** (\`console --all\`): ${r.consoleErrors ?? '?'} error(s) · **Backend log:** ${r.backend.unhandled} Unhandled error(s)`
  )
  if (r.load.length) lines.push(`- **Load** (1 min): ${Math.min(...r.load)}–${Math.max(...r.load)}`)
  lines.push(
    `- **Record:** \`${folder}/\` — trace.bin (\`bombadil browser inspect ${folder}/trace.bin\`), bombadil.log, ` +
      'logs/app.log, console-all.txt, refused.txt, doctor-start.txt, doctor-end.txt, status-start.txt, status-end.txt, spec/'
  )
  return lines
}

export interface ReportMeta {
  title: string
  checkout: string
  bombadil: string
  spec: { hash: string; verified: boolean }
  runs: number
  seconds: number
}

export function renderReport(meta: ReportMeta, records: RunRecord[]): string {
  const out: string[] = [`# ${meta.title}`, '']
  out.push(
    `${meta.runs} run(s) of ${clock(meta.seconds)} each, sealed, seeded and prepared with the model recipe of features/model.md; ` +
      `checkout ${meta.checkout}; Bombadil ${meta.bombadil}; spec ${meta.spec.hash.slice(0, 12)}.`,
    ''
  )
  if (!meta.spec.verified)
    out.push(
      '**The spec has changed since its positive controls last passed** (features/explore/controls/verified.json): ' +
        'a property that stays green may not be able to go red. Run `explore --control all`.',
      ''
    )
  const findings = records.flatMap(findingsOf)
  const open = records.filter((r) => r.outcome !== 'complete')
  out.push('## Verdict', '')
  out.push(
    findings.length === 0 && open.length === 0
      ? 'No findings, every run complete.'
      : `${findings.length} finding(s); ${open.length} run(s) not complete.`,
    ''
  )
  out.push(
    '| Run | Outcome | States | Pages | Dialog types | Coverage | Findings |',
    '|---|---|---|---|---|---|---|'
  )
  for (const r of records) {
    const d = r.digest
    out.push(
      `| ${r.session} | ${r.outcome} | ${d?.states ?? '—'} | ${d ? pagesOf(d).length : '—'} | ${d?.dialogTypes.length ?? '—'} | ` +
        `${d?.coverage ? pct(d.coverage.hit, d.coverage.total) : '—'} | ${findingsOf(r).length} |`
    )
  }
  out.push('')
  const union = new Set(records.flatMap((r) => r.hitBlocks))
  const total = Math.max(0, ...records.map((r) => r.totalBlocks))
  const named = new Set(records.flatMap((r) => r.namedFunctions))
  const pages = new Set(records.flatMap((r) => pagesOf(r.digest)))
  const dialogs = new Set(records.flatMap((r) => r.digest?.dialogTypes ?? []))
  out.push(
    `Together: ${pct(union.size, total)} of the blocks, ${named.size} named functions, ${pages.size} pages, ${dialogs.size} dialog types.`,
    ''
  )
  if (findings.length) {
    out.push('## Findings', '')
    for (const f of findings) {
      out.push(`### ${f.run}: ${f.title}`, '', `Source: ${f.source}.`, '')
      for (const l of f.lines) out.push(`- ${l}`)
      out.push('')
    }
  }
  out.push('## Runs', '')
  for (const r of records) {
    const folder = r.dir.split(/[/\\]/).slice(-1)[0]
    out.push(`### ${r.session} — ${r.label}`, '', ...runLines(r, folder), '')
  }
  out.push(
    '## Reproducing a finding',
    '',
    'By hand, with control-prism, from the trace: `bombadil browser inspect <run>/trace.bin` shows each state with its ' +
      'screenshot and the action that led to it, and `bombadil trace --json --state A..B <run>/trace.bin` prints them. ' +
      'Start from `launch --seed --sealed` and the model recipe of features/model.md, then drive the actions before the ' +
      "finding's state. Bombadil's `--reproduce` is not used: on this app a replay leaves the recorded path within " +
      'seconds (sub-pixel layout, ids made fresh per session, content that loads after the action).',
    '',
    'Not covered by these runs: links between boxes (no drag), right-click menus, what lies behind native dialogs, ' +
      'the chat with a key, persistence over a restart, Windows.',
    ''
  )
  return out.join('\n')
}
