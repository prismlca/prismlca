/**
 * How a command names the element it acts on, and how that name becomes a Playwright locator.
 *
 * The convention, strongest first — the feature map (`frontend/features/README.md`) uses it throughout:
 *
 *   Run                          exact aria-label (a bare string is always an aria-label)
 *   role=button:Calculate        role and exact accessible name, as `snapshot` prints them
 *   title=Settings               exact title attribute
 *   label=Workspace name         a form field by its label
 *   placeholder=e.g. electricity exact placeholder
 *   text=Bring your background data   visible text
 *   css=.chat-send.stop          a CSS selector — the fallback for controls without a name
 *
 * `~=` instead of `=` matches a substring, and a value written `/…/flags` is a regular expression. Parts
 * chain with ` >> ` to narrow the scope: `css=.chat-panel >> title=Collapse`. Three modifiers narrow a
 * match further: `has-text=…` (keeps elements containing that text), `visible` (drops hidden copies, e.g.
 * of a tab that stays mounted) and `nth=0` (the first of several).
 */
import type { Locator, Page } from '@playwright/test'

type Match = { kind: 'exact' | 'contains'; value: string } | { kind: 'regex'; value: RegExp }

export type Step =
  | { by: 'aria' | 'title' | 'placeholder'; match: Match }
  | { by: 'label' | 'text'; match: Match }
  | { by: 'role'; role: string; name?: Match }
  | { by: 'css'; selector: string }
  | { by: 'has-text'; match: Match }
  | { by: 'visible' }
  | { by: 'nth'; index: number }

const ATTRIBUTE = { aria: 'aria-label', title: 'title', placeholder: 'placeholder' } as const

const PREFIXES = ['aria', 'role', 'title', 'label', 'placeholder', 'text', 'css', 'has-text', 'nth']

export class TargetError extends Error {}

/** `/…/flags` as a RegExp, anything else as an exact or substring match. */
function match(raw: string, contains: boolean): Match {
  const re = /^\/(.+)\/([dgimsuy]*)$/s.exec(raw)
  if (re) {
    try {
      return { kind: 'regex', value: new RegExp(re[1], re[2]) }
    } catch (e) {
      throw new TargetError(`"${raw}" is not a valid regular expression: ${(e as Error).message}`)
    }
  }
  return { kind: contains ? 'contains' : 'exact', value: raw }
}

function step(part: string): Step {
  if (part === 'visible') return { by: 'visible' }
  const m = /^([a-z-]+)(~?)=(.*)$/s.exec(part)
  if (!m) return { by: 'aria', match: match(part, false) }
  const [, prefix, tilde, value] = m
  if (value === '' && prefix !== 'role') throw new TargetError(`"${part}" names nothing after the "=".`)
  const contains = tilde === '~'
  switch (prefix) {
    case 'aria':
    case 'title':
    case 'placeholder':
    case 'label':
    case 'text':
    case 'has-text':
      return { by: prefix, match: match(value, contains) }
    case 'css':
      return { by: 'css', selector: value }
    case 'nth': {
      const index = Number(value)
      if (!Number.isInteger(index))
        throw new TargetError(`nth= takes a whole number (0 is the first), not "${value}".`)
      return { by: 'nth', index }
    }
    case 'role': {
      const colon = value.indexOf(':')
      const role = (colon < 0 ? value : value.slice(0, colon)).trim()
      if (!/^[a-z]+$/.test(role))
        throw new TargetError(`"${part}" needs a role such as role=button:Calculate.`)
      return colon < 0
        ? { by: 'role', role }
        : { by: 'role', role, name: match(value.slice(colon + 1), contains) }
    }
    default:
      throw new TargetError(
        `"${prefix}=" is not a target prefix. Use one of ${PREFIXES.join(', ')} — or write the aria-label ` +
          `as it is, or as aria=${part} when the label itself contains "=".`
      )
  }
}

/** Splits a target into its steps; throws TargetError with the correct form when it cannot. */
export function parseTarget(target: string): Step[] {
  const parts = target.split(' >> ').map((p) => p.trim())
  if (parts.some((p) => p === '')) throw new TargetError(`"${target}" has an empty part around " >> ".`)
  const steps = parts.map(step)
  if (steps[0].by === 'nth' || steps[0].by === 'visible' || steps[0].by === 'has-text') {
    throw new TargetError(
      `"${target}" starts with a modifier; name an element first, e.g. css=.flow-row >> nth=0.`
    )
  }
  return steps
}

function cssString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ') + '"'
}

/** Elements by one attribute: exact or substring through CSS, a RegExp through Playwright's attribute engine
 *  (the one behind `getByTitle(/…/)`). */
function attributeLocator(scope: Page | Locator, attribute: string, m: Match): Locator {
  if (m.kind === 'regex') return scope.locator(`internal:attr=[${attribute}=${m.value.toString()}]`)
  return scope.locator(`[${attribute}${m.kind === 'contains' ? '*=' : '='}${cssString(m.value)}]`)
}

function textOptions(m: Match): [string | RegExp, { exact: boolean }] {
  return m.kind === 'regex' ? [m.value, { exact: false }] : [m.value, { exact: m.kind === 'exact' }]
}

/** The locator the steps describe, starting from the page. */
export function toLocator(page: Page, steps: Step[]): Locator {
  let scope: Page | Locator = page
  for (const s of steps) scope = apply(scope, s)
  return scope as Locator
}

function apply(scope: Page | Locator, s: Step): Locator {
  switch (s.by) {
    case 'aria':
    case 'title':
    case 'placeholder':
      return attributeLocator(scope, ATTRIBUTE[s.by], s.match)
    case 'label':
      return scope.getByLabel(...textOptions(s.match))
    case 'text':
      return scope.getByText(...textOptions(s.match))
    case 'role': {
      const role = s.role as Parameters<Page['getByRole']>[0]
      if (!s.name) return scope.getByRole(role)
      const [name, { exact }] = textOptions(s.name)
      return scope.getByRole(role, { name, exact })
    }
    case 'css':
      return scope.locator(s.selector)
    case 'has-text':
      // A string here is a case-insensitive substring (Playwright's hasText); write /^…$/ for an exact match.
      return (scope as Locator).filter({ hasText: s.match.value })
    case 'visible':
      return (scope as Locator).filter({ visible: true })
    case 'nth':
      return (scope as Locator).nth(s.index)
  }
}
