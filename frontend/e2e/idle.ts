/**
 * The window at rest: once a step has finished loading, the renderer does nothing until the next input.
 *
 * A render loop breaks no assertion. The Workbench once rendered without pause while its canvas was open, and
 * the Report page once sat on "Loading…" at full CPU; both changed nothing a test looks at and raised no error.
 * What they did leave is work nobody asked for, and that is measured here, over windows of WINDOW_MS:
 *
 * - **React commits**, counted by a stand-in for React's DevTools hook that `launch()` puts into the page
 *   before the renderer's bundle runs. react-dom reports every commit to that hook, in its production build too.
 * - **Script time** of the renderer's main thread, from the Chrome DevTools Protocol (`Performance.getMetrics`).
 *
 * Not DOM mutations or long tasks: React re-renders without touching the DOM when nothing changed, and a loop
 * of short tasks never crosses the long-task threshold.
 *
 * Rest is not zero. A chart finishes its animation, a debounced save of the view lands, a request resolves a
 * moment after the spinner went. So a step gets SETTLE_MS to come to rest and passes on its first quiet window;
 * a loop never has one. A renderer that hangs outright blocks the measurement itself and fails on the test's
 * own timeout.
 */
import type { CDPSession, Page } from '@playwright/test'

// The limits, against what was measured: the first quiet window after a step mostly holds 0 commits and 0 to
// 1 ms of script, at most 3 commits and 23 ms; a window while a step still loads holds 5 to 25 commits and 10
// to 90 ms. The two loops named above, brought back, held about 800 and 28 000 commits with 87 and 99 % of
// each window in script.
/** One measuring window. Long enough that a chart's last animation frame or a stray timer stays a blip. */
const WINDOW_MS = 1000
/** How long a step may take to come to rest after its loading has visibly ended. A slow runner needs room. */
const SETTLE_MS = 15_000
/** At rest: at most this many commits in one window — a late query result, a debounced save, a tooltip. */
const MAX_COMMITS = 3
/** At rest: the renderer's scripts ran at most this share of one window. */
const MAX_SCRIPT_SHARE = 0.1

/**
 * Installs the stand-in for React's DevTools hook. Runs in the page before any of its scripts (an init
 * script), so it must stay self-contained: Playwright sends its source text, not a closure. react-dom 18
 * uses three things of a hook: `supportsFiber` decides whether it registers at all, `inject` is called once
 * when it loads, `onCommitFiberRoot` after every commit. A real DevTools hook, if one is present, is left alone.
 */
export function installCommitCounter(): void {
  const w = window as unknown as Record<string, unknown>
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) return
  const counter = { renderers: 0, commits: 0 }
  w.__prismE2eReactCommits = counter
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => ++counter.renderers,
    onCommitFiberRoot: () => {
      counter.commits++
    }
  }
}

/** What the counter holds, and which document it belongs to (`performance.timeOrigin` is new per load). */
interface Counter {
  renderers: number
  commits: number
  document: number
}

function readCounter(page: Page): Promise<Counter | null> {
  return page.evaluate(() => {
    const c = (window as unknown as { __prismE2eReactCommits?: { renderers: number; commits: number } })
      .__prismE2eReactCommits
    return c ? { renderers: c.renderers, commits: c.commits, document: performance.timeOrigin } : null
  })
}

/** Whether React registered with the commit counter in the page's current document. */
export async function reactRegistered(page: Page): Promise<boolean> {
  return ((await readCounter(page))?.renderers ?? 0) > 0
}

/** The renderer's work so far in one document: React commits, and milliseconds of script. */
interface Work {
  commits: number
  scriptMs: number
  at: number
  document: number
}

const sessions = new WeakMap<Page, Promise<CDPSession>>()

function devtools(page: Page): Promise<CDPSession> {
  let session = sessions.get(page)
  if (!session) {
    session = page
      .context()
      .newCDPSession(page)
      .then(async (cdp) => {
        await cdp.send('Performance.enable')
        return cdp
      })
    sessions.set(page, session)
  }
  return session
}

/** Reads the renderer's work so far. Fails without the commit counter: nothing could be measured. */
async function workSoFar(page: Page): Promise<Work> {
  const cdp = await devtools(page)
  const [counter, { metrics }] = await Promise.all([readCounter(page), cdp.send('Performance.getMetrics')])
  if (!counter?.renderers) {
    throw new Error(
      counter
        ? 'React never registered with the commit counter in this window, so its commits cannot be counted.'
        : 'The React commit counter is not in this window. launch() installs it as an init script; a window ' +
          'not started through launch() has none.'
    )
  }
  const script = metrics.find((m) => m.name === 'ScriptDuration')?.value ?? 0
  return { commits: counter.commits, scriptMs: script * 1000, at: Date.now(), document: counter.document }
}

/** What the renderer did in one window: commits, milliseconds of script, and the window's real length. */
interface Interval {
  commits: number
  scriptMs: number
  ms: number
}

function between(from: Work, to: Work): Interval {
  return { commits: to.commits - from.commits, scriptMs: to.scriptMs - from.scriptMs, ms: to.at - from.at }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const quiet = (w: Interval): boolean => w.commits <= MAX_COMMITS && w.scriptMs <= w.ms * MAX_SCRIPT_SHARE

const shown = (w: Interval): string =>
  `${w.commits} commits, ${Math.round(w.scriptMs)} ms script in ${Math.round(w.ms)} ms`

/**
 * Asserts that the renderer comes to rest after `step`. Call it once the step's loading has visibly ended
 * (the result is on screen, the spinner gone): it measures, it does not wait for anything to appear. Logs one
 * line per check — the record the limits above are calibrated against.
 */
export async function expectRest(page: Page, step: string): Promise<void> {
  const started = Date.now()
  const seen: Interval[] = []
  let before = await workSoFar(page)
  while (!seen.some(quiet) && Date.now() - started < SETTLE_MS) {
    await sleep(WINDOW_MS)
    const after = await workSoFar(page)
    // Counts of two documents do not compare, and whatever the step had loaded went with the first one.
    if (after.document !== before.document) {
      throw new Error(
        `The page loaded anew while the rest after ${step} was measured — nothing in the step should reload it.`
      )
    }
    seen.push(between(before, after))
    before = after
  }
  const last = seen[seen.length - 1]
  if (quiet(last)) {
    const busiest = seen.reduce((a, b) => (b.scriptMs > a.scriptMs ? b : a))
    console.log(
      `[rest] ${step}: at rest after ${seen.length} window(s)` +
        (seen.length > 1 ? `, busiest ${shown(busiest)}` : `, ${shown(last)}`)
    )
    return
  }
  throw new Error(
    `The window did not come to rest after ${step}: in ${Math.round(SETTLE_MS / 1000)} s no ` +
      `${WINDOW_MS / 1000}-second window had at most ${MAX_COMMITS} React commits and at most ` +
      `${MAX_SCRIPT_SHARE * 100} % script time. Last windows: ${seen.slice(-3).map(shown).join('; ')}. ` +
      'Something renders without input — look for an effect that sets state and depends on a value made ' +
      'fresh in every render (an inline callback, object or array).'
  )
}
