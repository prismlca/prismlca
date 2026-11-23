/**
 * `drag`: a person presses on one element, moves the pointer to another and lets go. One command covers
 * both kinds of drag the app has: drags the page follows with its own pointer handlers (a link from one
 * box's handle to another's, moving a box) and HTML5 drag-and-drop (a search hit onto the canvas, a model
 * card into a folder, a parameter into a group).
 *
 * Both go through Playwright's mouse. In Chromium, and so in Electron, a move with the button down that
 * starts an HTML5 drag is caught where the browser would hand it to the operating system, and the drag goes
 * on inside the browser with the data the page's own dragstart put on it: dragenter, dragover and drop reach
 * the page as they do from a person's hand. Not driven is the operating system's drag session — a drag in
 * from another program (files onto the chat) or out of the window stays manual.
 *
 * Both ends are checked before the button goes down: a drag that broke off halfway would leave something in
 * the pointer's hand, and letting go then drops it wherever the pointer happens to be.
 */
import type { Locator, Page } from '@playwright/test'
import type { Flags } from './actions'
import { parseTarget, toLocator } from './targets'
import { describeSeen, seenAndStop, watch, type Seen } from './dragSeen'
import { waitTimeout, withDeadline } from './waits'

export const DRAG_USAGE = 'drag <from> <to> [--from-offset <x>,<y>] [--to-offset <x>,<y>] [--steps <n>]'

const DRAG_MS = 10_000
const DEFAULT_STEPS = 10
const MAX_STEPS = 100

export interface Point {
  x: number
  y: number
}

type Box = Point & { width: number; height: number }

/** `--from-offset`/`--to-offset`: "x,y" in CSS pixels from the element's top-left corner. */
export function parseOffset(flag: string | true | undefined, name: string): Point | undefined {
  if (flag === undefined) return undefined
  const m = typeof flag === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(flag) : null
  if (!m)
    throw new Error(
      `--${name} takes "x,y" in pixels from the element's top-left corner, e.g. --${name} 200,120 (got "${String(flag)}")`
    )
  return { x: Number(m[1]), y: Number(m[2]) }
}

/** `--steps`: how many pointer moves carry the drag from one end to the other. */
export function parseSteps(flag: string | true | undefined): number {
  if (flag === undefined) return DEFAULT_STEPS
  const n = typeof flag === 'string' && /^\d+$/.test(flag) ? Number(flag) : NaN
  if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS)
    throw new Error(`--steps takes a whole number from 1 to ${MAX_STEPS}, not "${String(flag)}"`)
  return n
}

/** The point an offset names inside a box, or the box's centre; throws when the offset lies outside it. */
export function pointIn(box: Box, offset: Point | undefined, raw: string, name: string): Point {
  if (!offset) return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  if (offset.x >= box.width || offset.y >= box.height) {
    throw new Error(
      `--${name} ${offset.x},${offset.y} lies outside ${raw}, which is ${Math.round(box.width)}×${Math.round(box.height)} px`
    )
  }
  return { x: box.x + offset.x, y: box.y + offset.y }
}

function at(p: Point): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`
}

/** How far the pointer moves right after the press: a hand starts a drag with a nudge, not a leap. */
const NUDGE_PX = 2

/** The button-down phase may take this long even when the preflight used up the command's time. */
const GESTURE_MS = 5_000

/** What lies on top at a point of the window, if it is not `loc` or inside it: the element a press or a
 *  drop there reaches instead. */
async function coveredBy(loc: Locator, p: Point, timeout: number): Promise<string | null> {
  return loc.evaluate(
    (el, { x, y }) => {
      const hit = document.elementFromPoint(x, y)
      if (hit && (hit === el || el.contains(hit))) return null
      if (!hit) return 'nothing (the point is outside the window)'
      // The attribute, not className: an SVG element keeps its class in an object.
      const cls = (e: Element): string[] =>
        (e.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)
      const name = (e: Element): string =>
        `<${e.tagName.toLowerCase()}${cls(e).length ? '.' + cls(e).join('.') : ''}>`
      // A bare <rect> or <span> says little; the nearest ancestor with a class says what it belongs to.
      const owner = cls(hit).length ? null : hit.parentElement?.closest('[class]')
      return owner ? `${name(hit)} in ${name(owner)}` : name(hit)
    },
    p,
    { timeout }
  )
}

async function boxOf(loc: Locator, raw: string, timeout: number): Promise<Box> {
  const box = await loc.boundingBox({ timeout })
  if (!box) throw new Error(`${raw} is not on screen`)
  return box
}

/** An offset from the border box (this command's convention) as Playwright counts a position: from the
 *  padding box. */
async function asPosition(loc: Locator, offset: Point, timeout: number): Promise<Point> {
  const border = await loc.evaluate(
    (el) => {
      const s = getComputedStyle(el)
      return { left: parseFloat(s.borderLeftWidth) || 0, top: parseFloat(s.borderTopWidth) || 0 }
    },
    undefined,
    { timeout }
  )
  return { x: offset.x - border.left, y: offset.y - border.top }
}

/** The window stopped answering with the button down: the drag may still finish once it answers again, so
 *  the session must not drive on as if nothing happened. */
export class InputBroken extends Error {}

const STALLED = 'the button-down phase of the drag ran out of time'

/** The pointer, the keyboard and a window to ask: what the button-down phase needs of a page. */
export type Hand = Pick<Page, 'mouse' | 'keyboard' | 'evaluate'>

/**
 * Ends a drag that broke off with the button down, without dropping it: Escape first — Playwright cancels
 * an HTML5 drag it holds and keeps the key from the page; with none held, the page gets the key as from a
 * person giving up — then the button. Each step bounded: the window may be what broke.
 */
async function letGo(page: Hand): Promise<boolean> {
  const escaped = await withDeadline(page.keyboard.press('Escape'), 2000).then(
    () => true,
    () => false
  )
  const up = await withDeadline(page.mouse.up(), 2000).then(
    () => true,
    () => false
  )
  return escaped && up
}

/**
 * The button-down phase of a drag: to the start, press, a nudge, across in `steps` moves, let go — all of it
 * within `ms`, and what the page saw of it. A step that fails is cancelled before the button comes up, so a
 * failure drops nothing. When the window stops answering, or the cancel fails, the button may still be
 * down: InputBroken.
 */
export async function gesture(
  page: Hand,
  start: Point,
  end: Point,
  steps: number,
  ms: number
): Promise<Seen | null> {
  let seen: Seen | null = null
  let pressed = false
  const run = async (): Promise<void> => {
    await watch(page)
    await page.mouse.move(start.x, start.y)
    // Counted as down before the press is sent: a press that fails may still have left the button down.
    pressed = true
    await page.mouse.down()
    // A nudge first, as a hand does: a page that starts its drag past a threshold (React Flow moves a box
    // from where its drag started) would otherwise lose the whole first step.
    const dx = end.x - start.x
    const dy = end.y - start.y
    const k = Math.min(1, NUDGE_PX / (Math.hypot(dx, dy) || 1))
    await page.mouse.move(start.x + dx * k, start.y + dy * k)
    await page.mouse.move(end.x, end.y, { steps })
    await page.mouse.up()
    pressed = false
  }
  try {
    await withDeadline(run(), ms, STALLED)
  } catch (e) {
    const message = (e as Error).message
    if (message === STALLED) {
      throw new InputBroken(
        `the window stopped answering in the middle of the drag (${ms / 1000} s); the button may still be ` +
          'down, and the drag may still finish once the window answers again. This session drives nothing ' +
          'more until restart: look with snapshot or shot, then restart or stop.'
      )
    }
    if (!pressed) throw e
    if (!(await letGo(page))) {
      throw new InputBroken(
        `the drag broke off with the button down (${message.split('\n')[0]}), and cancelling it failed too: ` +
          'the button may still be down. This session drives nothing more until restart: look with ' +
          'snapshot or shot, then restart or stop.'
      )
    }
    throw new Error(
      `the drag broke off with the button down (${message.split('\n')[0]}); it was cancelled with Escape ` +
        'and the button let go, so nothing was dropped on purpose — look with snapshot or shot before going on'
    )
  } finally {
    seen = await seenAndStop(page)
  }
  return seen
}

/**
 * Presses on `from` (its centre, or --from-offset), nudges, moves the pointer in --steps moves to `to` (its
 * centre, or --to-offset) and lets go. Offsets count from the top-left corner of the element's box as
 * `boundingBox` reports it. The answer says where it let go and what kind of drag it was; whether the drop
 * did anything is for a `wait` on its effect to show — a box on the canvas, an "Add exchange" dialog, the
 * card in its folder.
 */
export async function drag(page: Page, args: string[], flags: Flags): Promise<string> {
  if (args.length !== 2) throw new Error(`usage: ${DRAG_USAGE}`)
  const [fromRaw, toRaw] = args
  const from = toLocator(page, parseTarget(fromRaw))
  const to = toLocator(page, parseTarget(toRaw))
  const fromOffset = parseOffset(flags['from-offset'], 'from-offset')
  const toOffset = parseOffset(flags['to-offset'], 'to-offset')
  const steps = parseSteps(flags.steps)
  const until = Date.now() + (flags.timeout === undefined ? DRAG_MS : waitTimeout(flags.timeout))
  const left = (): number => Math.max(until - Date.now(), 1)

  // Each end one element on screen, each offset inside its element. The target is scrolled to first and
  // measured last: bringing the source into view can scroll the list both sit in.
  await to.waitFor({ state: 'visible', timeout: left() })
  await from.waitFor({ state: 'visible', timeout: left() })
  pointIn(await boxOf(from, fromRaw, left()), fromOffset, fromRaw, 'from-offset')
  pointIn(await boxOf(to, toRaw, left()), toOffset, toRaw, 'to-offset')
  await to.scrollIntoViewIfNeeded({ timeout: left() })
  // Visible, still and on top at the grab point, scrolled into view — a trial: the pointer does not move yet.
  const position = fromOffset && (await asPosition(from, fromOffset, left()))
  await from.hover({ trial: true, position, timeout: left() })
  const start = pointIn(await boxOf(from, fromRaw, left()), fromOffset, fromRaw, 'from-offset')
  const grab = await coveredBy(from, start, left())
  if (grab) {
    throw new Error(
      `at ${at(start)} ${fromRaw} is covered by ${grab}, so a press there would not grab it — pick another --from-offset`
    )
  }
  const end = pointIn(await boxOf(to, toRaw, left()), toOffset, toRaw, 'to-offset')
  const view =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  if (end.x < 0 || end.y < 0 || end.x >= view.width || end.y >= view.height) {
    throw new Error(
      `${toRaw} at ${at(end)} is out of view while ${fromRaw} is in view; a person cannot reach it in one drag`
    )
  }
  const cover = await coveredBy(to, end, left())
  if (cover) {
    throw new Error(
      `at ${at(end)} ${toRaw} is covered by ${cover}, so a drop there would not reach it — pick another --to-offset`
    )
  }

  const seen = await gesture(page, start, end, steps, Math.max(left(), GESTURE_MS))
  return (
    `dragged ${fromRaw} from ${at(start)} onto ${toRaw} at ${at(end)} in ${steps} move${steps === 1 ? '' : 's'}` +
    describeSeen(seen)
  )
}
