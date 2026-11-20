/**
 * `wait`: until something a person could see is true, never for a fixed time, and never longer than the
 * stated bound. Each condition polls from this process — a loop inside the renderer would hold its only
 * thread, so React could never render the state the loop waits for, and the window would freeze.
 *
 * Named states cover what the feature map calls an end state; everything else is a condition on a target.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { parseTarget, toLocator } from './targets'

export const DEFAULT_WAIT_MS = 30_000
export const MAX_WAIT_MS = 15 * 60_000

export const WAIT_HELP = `conditions on a target:
  visible <target>            hidden <target>       (hidden also holds when nothing matches)
  enabled <target>            disabled <target>
  checked <target>            unchecked <target>
  text <target> <text>        contains the text (or /regex/); --exact for the whole text
  value <target> <value>      an input's value (or /regex/)
  attr <target> <name> <v>    an attribute's value (or /regex/)
  count <target> <n>          exactly n matches
named states:
  app-ready                   the engine is up and the window past its start screen
  chat-running                the shown chat has a run going (its Stop button is there)
  chat-idle                   no run in the shown chat
  download <name>             a file of that name (or /regex/) is complete in the download folder
every wait: --timeout <ms>, default ${DEFAULT_WAIT_MS}, at most ${MAX_WAIT_MS}`

export function waitTimeout(flag: string | true | undefined): number {
  if (flag === undefined) return DEFAULT_WAIT_MS
  const ms = Number(flag)
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout takes milliseconds, not "${String(flag)}"`)
  if (ms > MAX_WAIT_MS)
    throw new Error(`--timeout is at most ${MAX_WAIT_MS} ms (15 min); a longer wait is a hang, not a state`)
  return ms
}

/** `promise`, or a rejection once `ms` have passed — for questions to a window that may not answer. */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message = `no answer within ${ms} ms`
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(message)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function textOrRegex(raw: string): string | RegExp {
  const m = /^\/(.+)\/([dgimsuy]*)$/s.exec(raw)
  return m ? new RegExp(m[1], m[2]) : raw
}

/** A read-back for the answer line: enough to recognise, never a page of text. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 160 ? flat.slice(0, 160) + '…' : flat)
}

function need(args: string[], n: number, usage: string): void {
  if (args.length < n) throw new Error(`usage: wait ${usage}`)
}

/** The engine is up: the start screen (`main.gate`) is gone. A start that failed says so on that screen. */
async function appReady(page: Page, timeout: number): Promise<string> {
  const gate = page.locator('main.gate')
  const failed = page.locator('main.gate .status.bad')
  const until = Date.now() + timeout
  const late = `the app was still on its start screen after ${timeout / 1000} s`
  // Each question to the window is bounded by what is left, so a frozen window cannot stretch the wait.
  const ask = <T>(q: Promise<T>): Promise<T> => withDeadline(q, Math.max(until - Date.now(), 1), late)
  while (Date.now() < until) {
    if ((await ask(failed.count())) > 0) {
      const text = await ask(page.locator('main.gate').innerText())
      throw new Error(`the app did not start: ${text.replace(/\s+/g, ' ')}`)
    }
    if ((await ask(gate.count())) === 0) return 'the app is ready'
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(late)
}

async function download(dir: string, name: string, timeout: number): Promise<string> {
  const want = textOrRegex(name)
  const matches = (f: string): boolean => (typeof want === 'string' ? f === want : want.test(f))
  const until = Date.now() + timeout
  let last = -1
  while (Date.now() < until) {
    const files = existsSync(dir) ? readdirSync(dir) : []
    const hit = files.find((f) => matches(f) && !f.endsWith('.crdownload'))
    if (hit) {
      // Complete once its size holds still between two looks.
      const size = statSync(join(dir, hit)).size
      if (size === last && size > 0) return `${join(dir, hit)} (${size} bytes)`
      last = size
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  const seen = existsSync(dir) ? readdirSync(dir) : []
  throw new Error(
    `no file "${name}" completed in ${dir} within ${timeout / 1000} s; there: ${seen.join(', ') || 'nothing'}`
  )
}

export async function runWait(
  page: Page,
  downloads: string,
  args: string[],
  flags: Record<string, string | true>
): Promise<string> {
  const timeout = waitTimeout(flags.timeout)
  const [what, ...rest] = args
  const loc = (): Locator => toLocator(page, parseTarget(rest[0]))
  switch (what) {
    case 'app-ready':
      return appReady(page, timeout)
    case 'chat-running':
      await expect(page.locator('.chat-send.stop')).toBeVisible({ timeout })
      return 'a run is going in the shown chat'
    case 'chat-idle':
      await expect(page.locator('.chat-send.stop')).toHaveCount(0, { timeout })
      return 'no run in the shown chat'
    case 'download':
      need(rest, 1, 'download <name>')
      return download(downloads, rest[0], timeout)
    case 'visible':
      need(rest, 1, 'visible <target>')
      await expect(loc()).toBeVisible({ timeout })
      return `${rest[0]} is visible`
    case 'hidden':
      need(rest, 1, 'hidden <target>')
      await expect(loc()).toBeHidden({ timeout })
      return `${rest[0]} is hidden`
    case 'enabled':
      need(rest, 1, 'enabled <target>')
      await expect(loc()).toBeEnabled({ timeout })
      return `${rest[0]} is enabled`
    case 'disabled':
      need(rest, 1, 'disabled <target>')
      await expect(loc()).toBeDisabled({ timeout })
      return `${rest[0]} is disabled`
    case 'checked':
    case 'unchecked':
      need(rest, 1, `${what} <target>`)
      await expect(loc()).toBeChecked({ checked: what === 'checked', timeout })
      return `${rest[0]} is ${what}`
    case 'text':
      need(rest, 2, 'text <target> <text>')
      if (flags.exact) await expect(loc()).toHaveText(textOrRegex(rest[1]), { timeout })
      else await expect(loc()).toContainText(textOrRegex(rest[1]), { timeout })
      return `${rest[0]} reads ${clip(await loc().innerText())}`
    case 'value':
      need(rest, 2, 'value <target> <value>')
      await expect(loc()).toHaveValue(textOrRegex(rest[1]), { timeout })
      return `${rest[0]} has the value ${JSON.stringify(await loc().inputValue())}`
    case 'attr':
      need(rest, 3, 'attr <target> <name> <value>')
      await expect(loc()).toHaveAttribute(rest[1], textOrRegex(rest[2]), { timeout })
      return `${rest[0]} has ${rest[1]}=${JSON.stringify(await loc().getAttribute(rest[1]))}`
    case 'count': {
      need(rest, 2, 'count <target> <n>')
      const n = Number(rest[1])
      if (!Number.isInteger(n) || n < 0) throw new Error(`count takes a whole number, not "${rest[1]}"`)
      await expect(loc()).toHaveCount(n, { timeout })
      return `${rest[0]} matches ${n} element${n === 1 ? '' : 's'}`
    }
    default:
      throw new Error(`"${what ?? ''}" is not a condition to wait for.\n${WAIT_HELP}`)
  }
}
