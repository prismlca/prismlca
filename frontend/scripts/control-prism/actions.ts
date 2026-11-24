/**
 * What a person does in the window — click, type, press, choose — and what they see: the accessibility
 * tree, a screenshot. Everything goes through Playwright's input path, so the traps of hand-written
 * JavaScript stay shut: typing produces real input events (a React-controlled field takes them, where an
 * assigned `.value` is ignored), leaving a field is a real focus change (`focusout`, which React's onBlur
 * listens to, rather than a synthetic `blur` that does not bubble), and hovering moves the pointer, so
 * `:hover` styles apply. Every action waits for its target to be visible, stable and enabled, within a
 * bound, and fails when the target names more than one element.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { parseTarget, toLocator } from './targets'
import { waitTimeout, withDeadline } from './waits'

export type Flags = Record<string, string | true>

const ACTION_MS = 10_000

function target(page: Page, raw: string | undefined, usage: string): Locator {
  if (!raw) throw new Error(`usage: ${usage}`)
  return toLocator(page, parseTarget(raw))
}

function actionTimeout(flags: Flags): number {
  return flags.timeout === undefined ? ACTION_MS : waitTimeout(flags.timeout)
}

/** The least a later step of a command gets, so a step after a slow first one is not refused outright. */
const STEP_MIN_MS = 500

/**
 * One bound for a command of several steps (fill, Enter, leave; key after key), shared by them: each step
 * gets what is left. The host's watchdog gives up on a command past this bound plus a margin
 * (watchdog.ts), so a bound per step would let a legitimate command outrun it.
 */
function budget(flags: Flags): () => number {
  const until = Date.now() + actionTimeout(flags)
  return () => Math.max(until - Date.now(), STEP_MIN_MS)
}

/** "Ctrl+Z" and "Cmd+K" in the spelling Playwright's keyboard knows. */
export function normaliseKeys(keys: string): string {
  return keys
    .split('+')
    .map((k) => {
      const lower = k.toLowerCase()
      if (lower === 'ctrl' || lower === 'control') return 'Control'
      if (lower === 'cmd' || lower === 'meta' || lower === 'command') return 'Meta'
      if (lower === 'alt' || lower === 'option') return 'Alt'
      if (lower === 'shift') return 'Shift'
      if (lower === 'esc') return 'Escape'
      if (lower === 'del') return 'Delete'
      if (lower === 'return') return 'Enter'
      return k.length === 1 ? k : k[0].toUpperCase() + k.slice(1)
    })
    .join('+')
}

export async function click(page: Page, args: string[], flags: Flags): Promise<string> {
  const loc = target(page, args[0], 'click <target> [--right] [--double]')
  const timeout = actionTimeout(flags)
  if (flags.double) await loc.dblclick({ timeout })
  else await loc.click({ timeout, button: flags.right ? 'right' : 'left' })
  return `clicked ${args[0]}`
}

export async function hover(page: Page, args: string[], flags: Flags): Promise<string> {
  await target(page, args[0], 'hover <target>').hover({ timeout: actionTimeout(flags) })
  return `pointer over ${args[0]}`
}

/**
 * Replaces the field's content (or appends with --append), then optionally presses Enter or leaves the
 * field. Many fields commit only then: an amount on Enter or blur, a name on blur. The value read back
 * afterwards is what the field shows, which is not yet what the backend stored — wait on the effect.
 */
export async function type(page: Page, args: string[], flags: Flags): Promise<string> {
  const loc = target(page, args[0], 'type <target> <text> [--append] [--enter] [--commit]')
  if (args.length < 2) throw new Error('usage: type <target> <text> [--append] [--enter] [--commit]')
  const left = budget(flags)
  if (flags.append) await loc.pressSequentially(args[1], { timeout: left() })
  else await loc.fill(args[1], { timeout: left() })
  if (flags.enter) await loc.press('Enter', { timeout: left() })
  if (flags.commit) await loc.blur({ timeout: left() })
  const then = flags.enter ? ' and pressed Enter' : flags.commit ? ' and left the field' : ''
  return `typed into ${args[0]}${then}`
}

/** Presses keys in order — on the focused element, or on a target first focused. */
export async function press(page: Page, args: string[], flags: Flags): Promise<string> {
  if (args.length === 0)
    throw new Error('usage: press <keys>… [--target <target>]   e.g. press Control+z, press Tab Tab Enter')
  const keys = args.map(normaliseKeys)
  const left = budget(flags)
  if (typeof flags.target === 'string') {
    const loc = toLocator(page, parseTarget(flags.target))
    for (const k of keys) await loc.press(k, { timeout: left() })
  } else {
    for (const k of keys) await page.keyboard.press(k)
  }
  return `pressed ${keys.join(' ')}`
}

function listed(labels: string[], max = 12): string {
  const shown = labels.slice(0, max).map((l) => JSON.stringify(l))
  return shown.join(', ') + (labels.length > max ? ` and ${labels.length - max} more` : '')
}

/**
 * Chooses an option of a <select>: by its exact visible label, by a /regex/ that matches exactly one label,
 * or by its value. A controlled select can still show the old value for a moment after the change; wait on
 * the effect (`wait value …`, or what the choice changes elsewhere), not on an immediate read-back.
 */
export async function select(page: Page, args: string[], flags: Flags): Promise<string> {
  const loc = target(page, args[0], 'select <target> <option label | /regex/ | value>')
  if (args.length < 2) throw new Error('usage: select <target> <option label | /regex/ | value>')
  const left = budget(flags)
  // The options are read before choosing; without this wait a target that is not there yet would read as
  // a list with no options.
  await loc.waitFor({ state: 'attached', timeout: left() })
  const labels = (await loc.locator('option').allInnerTexts()).map((l) => l.trim())
  const re = /^\/(.+)\/([imsu]*)$/s.exec(args[1])
  let label: string | undefined
  if (re) {
    const pattern = new RegExp(re[1], re[2])
    const hits = labels.filter((l) => pattern.test(l))
    if (hits.length !== 1) {
      throw new Error(
        hits.length === 0
          ? `no option of ${args[0]} matches ${args[1]}. Its options: ${listed(labels)}`
          : `${hits.length} options of ${args[0]} match ${args[1]}: ${listed(hits)} — make the pattern narrower`
      )
    }
    label = hits[0]
  } else if (labels.includes(args[1])) label = args[1]
  const chosen = label
    ? await loc.selectOption({ label }, { timeout: left() })
    : await loc.selectOption({ value: args[1] }, { timeout: left() }).catch(() => {
        throw new Error(`${args[0]} has no option "${args[1]}". Its options: ${listed(labels)}`)
      })
  return `selected ${JSON.stringify(label ?? args[1])} in ${args[0]} (value ${chosen.join(', ')})`
}

/**
 * Folds the options of every list box into the selected one and a count: the method choosers hold hundreds
 * of options, and a page snapshot would be mostly them. `--options` keeps them all.
 */
export function foldOptions(snapshot: string): string {
  const out: string[] = []
  let hidden = 0
  let indent = ''
  const flush = (): void => {
    if (hidden > 0)
      out.push(`${indent}- (${hidden} more option${hidden === 1 ? '' : 's'}; --options lists them)`)
    hidden = 0
  }
  for (const line of snapshot.split('\n')) {
    const m = /^(\s*)- '?option\b/.exec(line)
    if (m) {
      if (hidden > 0 && m[1] !== indent) flush()
      indent = m[1]
      if (/\[selected\]/.test(line)) out.push(line)
      else hidden++
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

export async function snapshot(page: Page, flags: Flags): Promise<string> {
  const loc =
    typeof flags.target === 'string' ? toLocator(page, parseTarget(flags.target)) : page.locator('body')
  const tree = await loc.ariaSnapshot({ timeout: actionTimeout(flags) })
  return flags.options ? tree : foldOptions(tree)
}

export async function shot(page: Page, file: string, flags: Flags): Promise<string> {
  const path = resolve(file)
  mkdirSync(dirname(path), { recursive: true })
  if (typeof flags.target === 'string') {
    await toLocator(page, parseTarget(flags.target)).screenshot({ path, timeout: actionTimeout(flags) })
  } else {
    await page.screenshot({ path, fullPage: !!flags.full })
  }
  return path
}

/**
 * Evaluates a JavaScript expression in the window and prints the result as JSON. For looking at state
 * after the user's path ran — never as the path itself, and never as the proof: nothing stops an
 * expression from changing what it reads. Bounded, because an expression that loops would hold the
 * renderer's only thread and freeze the window.
 */
export async function read(page: Page, args: string[]): Promise<string> {
  if (args.length !== 1) throw new Error("usage: read '<expression>'   e.g. read 'document.title'")
  const READ_MS = 10_000
  const value = await withDeadline(
    page.evaluate(args[0]),
    READ_MS,
    `the window did not answer within ${READ_MS / 1000} s. If the expression loops or waits, the renderer ` +
      'is stuck in it: stop and launch again, and wait from outside with `wait` instead.'
  )
  return JSON.stringify(value, null, 2) ?? 'undefined'
}

/** Playwright's messages carry terminal colours and a long call log; one line and a few log lines are enough. */
export function plainError(message: string, max = 6): string {
  const lines = message
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
  return lines.slice(0, max).join('\n')
}

/**
 * A failed action, said in terms of its targets (a drag has two): each that matches nothing (with the way to
 * find the right name) or several (with the ways to narrow) — or, when each names one element, that one of
 * them never became actionable.
 */
export async function explainFailure(
  page: Page,
  raw: string | string[] | undefined,
  error: Error,
  waiting = false
): Promise<string> {
  const message = plainError(error.message, waiting ? 10 : 6)
  const raws = (Array.isArray(raw) ? raw : [raw]).filter((r): r is string => !!r)
  if (raws.length === 0 || !/Timeout|strict mode violation/.test(message)) return message
  const problems: string[] = []
  for (const r of raws) {
    let count: number
    try {
      count = await toLocator(page, parseTarget(r)).count()
    } catch {
      return message
    }
    if (count === 0) {
      const bare = !/^[a-z-]+~?=/.test(r) && !r.includes(' >> ')
      problems.push(
        `nothing matches ${r} now.` +
          (bare ? ' A bare string is an exact aria-label;' : '') +
          ' snapshot lists the roles and names on screen (use them as role=button:Name).'
      )
    } else if (count > 1) {
      problems.push(
        `${r} matches ${count} elements; narrow it with " >> " — a container first, or has-text=…, visible, nth=0.`
      )
    }
  }
  if (problems.length > 0) return `${problems.join('\n')}\n${message}`
  // A wait that found its one element and timed out has its answer in Playwright's own lines (expected/received).
  if (waiting) return message
  const which =
    raws.length === 1 ? `${raws[0]} is there but` : `each of ${raws.join(' and ')} is there, but one`
  return `${which} did not become actionable (hidden, covered by a dialog, disabled or still moving) — snapshot or shot shows which.\n${message}`
}
