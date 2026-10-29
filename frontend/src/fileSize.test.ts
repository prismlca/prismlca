import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A tripwire against giant files, in the manner of the tool-count cap in
 * main/ai/tools.test.ts.
 *
 * Files like Results.tsx, Settings.tsx and CanvasChat.tsx did not start at 2000 lines. They grew by
 * accretion: each feature put its block where the state already lived, and each needed its own
 * refactoring round to come back. The rule says where new code goes instead (CLAUDE.md, "No new giant
 * files"); this makes the moment of deciding unmissable:
 *
 * - a file without an entry below stays within LIMIT lines;
 * - a file over it has a CEILING it must not outgrow. A ceiling is always the line count when it was set
 *   plus HEADROOM — room for the import and the call that wire in code moved elsewhere, which on a zero
 *   ceiling forced a raise for every feature (measured on a model before this shipped: it moved the helper
 *   out correctly, then bumped the ceiling anyway for the three lines left). A block-sized addition does
 *   not fit, and that is the point;
 * - when a file shrinks by SHRINK lines or more, its ceiling has to come down with it, or the freed room
 *   becomes a growth budget;
 * - EXEMPT holds flat catalogues and generated data, each with its reason: length is not their problem.
 *
 * Lines are counted like `wc -l`: newline bytes. Raising a ceiling is allowed and sometimes right; the
 * comment beside it says why the new lines belong in this file, not merely what the feature was.
 * Frequent raises on one file are the signal to cut it. Getting under a count by squeezing — deleting
 * comments, joining lines, dropping checks — is not a cut; the failure messages say so where they are read.
 */
const LIMIT = 800
const HEADROOM = 25
const SHRINK = 50

/** Paths relative to frontend/src. `<count + HEADROOM>` — the comment keeps the count. */
const CEILINGS: Record<string, number> = {
  'main/ai/agent.ts': 2028, // 2003
  'renderer/src/Workbench.tsx': 1862, // 1837
  'renderer/src/views/ReportSections.tsx': 1403, // 1378, after the correction path and the remark lists went (one state per chapter)
  'renderer/src/CanvasChat.tsx': 1277, // 1252
  'renderer/src/views/report/useChapterWriter.ts': 900, // 875, after the correction path went (Update report replaces it)
  'main/ai/subagent.ts': 1279, // 1254
  // 1199: the canvas selection lives here, so `selectOnly` does too, and its setter (now from
  // lib/useIdListState) is listed in the dependencies of every callback that clears the selection.
  'renderer/src/workbench/useCanvasModel.ts': 1216,
  'renderer/src/views/DetailedResults.tsx': 1250, // 1225
  'renderer/src/views/Report.tsx': 1202, // 1177
  'renderer/src/views/ImportWizard.tsx': 1208, // 1183
  'renderer/src/views/Parameters.tsx': 1198, // 1173
  'main/ai/reportWriter.ts': 905, // 880, after the conversation (writer/dialogue.ts) and the messages (writer/messages.ts) moved out
  'renderer/src/views/Results.tsx': 1099, // 1074
  'renderer/src/views/Overview.tsx': 889, // 864
  'main/ai/tools/groups/model.ts': 862 // 837
}

const EXEMPT: Record<string, string> = {
  'renderer/src/components/icons.tsx':
    'a flat catalogue of SVG glyphs, one small component each with its source note — it grows by one entry per new glyph, not by mixed responsibility'
}

/** Test helpers are test code, like the test files themselves. */
const SKIP_DIRS = ['main/ai/test/', 'renderer/src/test/']

const SRC = __dirname

function sourceFiles(): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
      .slice(SRC.length + 1)
      .split('\\')
      .join('/')
    if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path) || path.endsWith('.d.ts')) continue
    if (path.includes('node_modules/') || SKIP_DIRS.some((d) => path.startsWith(d))) continue
    const bytes = readFileSync(join(SRC, path))
    let lines = 0
    for (const b of bytes) if (b === 0x0a) lines++
    out.set(path, lines)
  }
  return out
}

const files = sourceFiles()
const RULE = 'CLAUDE.md, "No new giant files"'
/** The cheap way under a count is to make the file worse; it is ruled out where the failure is read. */
const NOT_BY_SQUEEZING =
  'Do not squeeze the file under the count: no deleting comments, no joining lines, no dropping ' +
  'checks, no shorter names — that hides the size and makes the file worse. Delete code only where ' +
  'that is plainly an improvement in itself, such as code nothing calls any more.'

describe('file sizes', () => {
  it('looks at the real tree — an empty walk would pass everything below', () => {
    expect(files.size).toBeGreaterThan(300)
    // Existence and a real count, not "over LIMIT": a file cut down below it must not trip this.
    expect(files.get('renderer/src/Workbench.tsx')).toBeGreaterThan(0)
  })

  it('keeps every file without a ceiling within the limit', () => {
    const over = [...files]
      .filter(([p, n]) => n > LIMIT && !(p in CEILINGS) && !(p in EXEMPT))
      .map(
        ([p, n]) =>
          `${p} has ${n} lines, over the ${LIMIT}-line limit for files without a ceiling. Split it by ` +
          `responsibility before committing (${RULE}). Only a flat catalogue of uniform entries or ` +
          `generated data belongs in EXEMPT in fileSize.test.ts instead, with the reason. ${NOT_BY_SQUEEZING}`
      )
    expect(over).toEqual([])
  })

  it('lets no file outgrow its ceiling', () => {
    const grown = Object.entries(CEILINGS)
      .filter(([p, ceiling]) => (files.get(p) ?? 0) > ceiling)
      .map(
        ([p, ceiling]) =>
          `${p} grew to ${files.get(p)} lines; its ceiling is ${ceiling}. The file is already too large ` +
          `to keep growing (${RULE}). Move the code you added into its own module beside it — a component ` +
          `into its view's folder, a pure helper into a sibling .ts, stateful logic into a hook — and ` +
          `import it from here. Raise the ceiling only when the new lines belong to what this file ` +
          `already does, and write in a comment next to the ceiling why they could not live elsewhere. ` +
          NOT_BY_SQUEEZING
      )
    expect(grown).toEqual([])
  })

  it('brings the ceilings down with the files', () => {
    const loose = Object.entries(CEILINGS)
      .filter(([p, ceiling]) => {
        const n = files.get(p)
        return n !== undefined && (n <= LIMIT || ceiling - n >= HEADROOM + SHRINK)
      })
      .map(([p, ceiling]) => {
        const n = files.get(p) as number
        return n <= LIMIT
          ? `${p} is down to ${n} lines, within the ${LIMIT}-line limit. Remove its entry from CEILINGS ` +
              `in fileSize.test.ts — the limit holds it from now on.`
          : `${p} is down to ${n} lines, ${ceiling - n} below its ceiling of ${ceiling}. Lower the ` +
              `ceiling in fileSize.test.ts to ${n + HEADROOM} (the count plus the ${HEADROOM}-line ` +
              `headroom every ceiling gets) so the freed room cannot be refilled.`
      })
    expect(loose).toEqual([])
  })

  it('lists only files that exist, each in one list', () => {
    const ghosts = [...Object.keys(CEILINGS), ...Object.keys(EXEMPT)].filter((p) => !files.has(p))
    expect(
      ghosts.map((p) => `${p} is listed in fileSize.test.ts but does not exist — remove or rename it.`)
    ).toEqual([])
    expect(Object.keys(CEILINGS).filter((p) => p in EXEMPT)).toEqual([])
    for (const [p, reason] of Object.entries(EXEMPT)) expect([p, reason.length > 20]).toEqual([p, true])
  })
})
