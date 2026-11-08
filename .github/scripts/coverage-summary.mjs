// The coverage report for a CI run's summary page: line coverage of the frontend (Vitest, v8) and the
// backend (coverage.py), and in each the files with the most uncovered lines — where tests are thinnest.
// A report, not a gate: nothing here fails a run.
//
//   node .github/scripts/coverage-summary.mjs <frontend coverage-summary.json> <backend coverage.json>
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Files with the most uncovered lines first, as {path, uncovered, total, pct}. */
function frontendFiles(summary) {
  return Object.entries(summary)
    .filter(([path]) => path !== 'total')
    .map(([path, { lines }]) => ({
      // v8 reports absolute paths; from `src/` on is what a reader finds in the repository.
      path: 'frontend/' + path.replace(/\\/g, '/').replace(/^.*?\/frontend\//, ''),
      uncovered: lines.total - lines.covered,
      total: lines.total,
      pct: lines.pct
    }))
}

function backendFiles(report) {
  return Object.entries(report.files).map(([path, { summary }]) => ({
    path: 'backend/' + path.replace(/\\/g, '/'),
    uncovered: summary.missing_lines,
    total: summary.num_statements,
    pct: summary.percent_covered
  }))
}

const pct = (n) => `${n.toFixed(1)} %`

function table(files, top) {
  const rows = [...files]
    .sort((a, b) => b.uncovered - a.uncovered || a.path.localeCompare(b.path))
    .slice(0, top)
    .map((f) => `| \`${f.path}\` | ${f.uncovered} | ${pct(f.pct)} |`)
  return ['| File | Uncovered lines | Covered |', '|---|---:|---:|', ...rows].join('\n')
}

/** The Markdown summary for both reports. */
export function summarize(frontendSummary, backendReport, top = 10) {
  const fe = frontendSummary.total.lines
  const be = backendReport.totals
  return [
    '## Test coverage',
    '',
    '| Part | Lines covered |',
    '|---|---:|',
    `| Frontend | ${pct(fe.pct)} (${fe.covered} of ${fe.total}) |`,
    `| Backend | ${pct(be.percent_covered)} (${be.covered_lines} of ${be.num_statements}) |`,
    '',
    'A report, not a gate. The full reports are this run’s `coverage` artifact.',
    '',
    `### Frontend: ${top} files with the most uncovered lines`,
    '',
    table(frontendFiles(frontendSummary), top),
    '',
    `### Backend: ${top} files with the most uncovered lines`,
    '',
    table(backendFiles(backendReport), top),
    ''
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [frontendPath, backendPath] = process.argv.slice(2)
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
  process.stdout.write(summarize(read(frontendPath), read(backendPath)))
}
