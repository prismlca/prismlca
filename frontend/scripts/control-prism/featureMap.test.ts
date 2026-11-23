import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './args'
import { parseTarget, type Step } from './targets'

/**
 * Holds the feature map (frontend/features/) to the interface it describes. A page that names a control
 * the renderer no longer has sends the next agent looking for it; this test sends the one who renamed it
 * to the page instead, in the same pull request.
 *
 * Checked: every page has the four sections in order; every control-prism command in a page's code blocks
 * parses; every target in them, and every quoted target in inline code (`"…"`), parses; and each exact
 * aria-label, title, placeholder, form label or text a target names occurs in the renderer's source.
 */

const FRONTEND = join(__dirname, '..', '..')
const FEATURES = join(FRONTEND, 'features')
const SECTIONS = ['Sub-features', 'How to get there', 'Driving it with control-prism', 'Gotchas']
const COMMAND = 'node scripts/control-prism.mjs '

const pages = readdirSync(FEATURES)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ file: f, text: readFileSync(join(FEATURES, f), 'utf8') }))

function rendererSource(): string {
  const root = join(FRONTEND, 'src', 'renderer', 'src')
  const parts: string[] = []
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue
    parts.push(readFileSync(join(e.parentPath, e.name), 'utf8'))
  }
  return parts.join('\n')
}

/** Splits a command line the way a POSIX shell does for "…" and '…' quoting (no expansions). */
export function shellWords(line: string): string[] {
  const words: string[] = []
  let word: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word = (word ?? '') + line.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      for (; line[j] !== '"'; j++) s += line[j] === '\\' && /["\\$`]/.test(line[j + 1]) ? line[++j] : line[j]
      word = (word ?? '') + s
      i = j
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
    } else word = (word ?? '') + c
  }
  if (word !== null) words.push(word)
  return words
}

/** The targets a parsed command names. */
function targetsOf(cmd: string, args: string[], flags: Record<string, string | true>): string[] {
  const found: string[] = []
  if (['click', 'hover', 'type', 'select'].includes(cmd)) found.push(args[0])
  if (cmd === 'drag') found.push(...args.slice(0, 2))
  const named = ['app-ready', 'chat-running', 'chat-idle', 'download']
  if (cmd === 'wait' && !named.includes(args[0])) found.push(args[1])
  if (typeof flags.target === 'string') found.push(flags.target)
  return found
}

function commands(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1])
  return blocks.flatMap((b) => b.split('\n')).filter((l) => l.startsWith(COMMAND))
}

function inlineTargets(text: string): string[] {
  const outside = text.replace(/```[\s\S]*?```/g, '')
  return [...outside.matchAll(/`"([^`]+)"`/g)].map((m) => m[1])
}

const ATTRIBUTE = { aria: 'aria-label', title: 'title', placeholder: 'placeholder' } as const

function escaped(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the renderer sets `attribute` to exactly `value`: as a JSX string (`aria-label="Send"`), as a
 * string inside the attribute's expression (`title={busy ? 'Stop' : 'Send'}`), or as an object entry
 * (`'aria-label': 'Send'`). The same words in a title, a comment or a text do not count.
 */
export function setsAttribute(source: string, attribute: string, value: string): boolean {
  const q = '[\'"`]'
  const v = escaped(value)
  const a = escaped(attribute)
  return [
    `\\b${a}=${q}${v}${q}`,
    `\\b${a}=\\{[^}\\n]*${q}${v}${q}`,
    `${q}?\\b${a}${q}?\\s*:\\s*${q}${v}${q}`
  ].some((p) => new RegExp(p).test(source))
}

/**
 * Names a page drives that are not one string in the renderer's source, so this test cannot look for them:
 * what the seed imports or a page's recipe creates (a flow, an indicator, a table row), and what the renderer
 * assembles from parts. Driving the page checks them.
 */
const NOT_LITERAL = new Set([
  // data: the bundled flow list and methods, the recipe's own model
  'Carbon dioxide, fossil air kilogram',
  '+ ★ climate change / global warming potential (GWP100) kg CO2-Eq',
  'bottle 4.00',
  // assembled: views/ActivityEditor.tsx, "+ Add {input|output} flow"
  '+ Add output flow'
])

/** What of a target is not in the renderer's source, as a list of reasons; empty when everything is. */
export function missingFrom(source: string, steps: Step[]): string[] {
  const missing: string[] = []
  for (const s of steps) {
    if ((s.by === 'aria' || s.by === 'title' || s.by === 'placeholder') && s.match.kind === 'exact') {
      const attribute = ATTRIBUTE[s.by]
      if (!setsAttribute(source, attribute, s.match.value)) missing.push(`no ${attribute}="${s.match.value}"`)
    } else if ((s.by === 'label' || s.by === 'text') && s.match.kind === 'exact') {
      if (!source.includes(s.match.value)) missing.push(`no text "${s.match.value}"`)
    } else if (s.by === 'role' && s.name?.kind === 'exact' && !NOT_LITERAL.has(s.name.value)) {
      // An accessible name comes from an aria-label, a title or the text: any of them will do.
      if (!source.includes(s.name.value)) missing.push(`no name "${s.name.value}"`)
    }
  }
  return missing
}

describe('feature map', () => {
  const source = rendererSource()

  it('has pages', () => {
    expect(pages.map((p) => p.file)).toContain('README.md')
    expect(pages.length).toBeGreaterThan(1)
  })

  for (const page of pages) {
    describe(page.file, () => {
      if (page.file !== 'README.md') {
        it('has the four sections, in order', () => {
          const h2 = [...page.text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
          expect(h2, `${page.file} must have exactly these sections: ${SECTIONS.join(', ')}`).toEqual(
            SECTIONS
          )
        })
      }

      it('has commands and targets that parse and name what the renderer has', () => {
        const targets: string[] = []
        for (const line of commands(page.text)) {
          const { cmd, args, flags } = parseArgs(shellWords(line.slice(COMMAND.length)))
          targets.push(...targetsOf(cmd, args, flags))
        }
        targets.push(...inlineTargets(page.text))
        const missing: string[] = []
        for (const t of targets) {
          for (const reason of missingFrom(source, parseTarget(t))) missing.push(`${t}: ${reason}`)
        }
        expect(
          missing,
          `${page.file} names controls the renderer no longer has — update the page with the change:\n  ` +
            missing.join('\n  ')
        ).toEqual([])
      })
    })
  }
})

describe('missingFrom', () => {
  const source = [
    '<button className="chat-send" title="Send">➤</button>',
    "<select title={p.methods.length ? name : 'LCIA method'} />",
    '{/* the aria-label "Stop" goes here */}',
    "<b aria-label={busy ? 'Working' : 'Idle'}>",
    "const props = { 'aria-label': 'Close' }",
    '<span>+ Add output flow</span>'
  ].join('\\n')
  const check = (t: string): string[] => missingFrom(source, parseTarget(t))

  it('finds a label that is set, also inside an expression or an object', () => {
    expect(check('Working')).toEqual([])
    expect(check('Close')).toEqual([])
    expect(check('title=Send')).toEqual([])
    expect(check('title=LCIA method')).toEqual([])
    expect(check('role=button:+ Add output flow')).toEqual([])
  })

  it('misses a label whose words survive only in a title, a comment or a text', () => {
    expect(check('Send')).toEqual(['no aria-label="Send"'])
    expect(check('Stop')).toEqual(['no aria-label="Stop"'])
    expect(check('LCIA method')).toEqual(['no aria-label="LCIA method"'])
    expect(check('title=Close')).toEqual(['no title="Close"'])
    expect(check('role=button:+ Add input flow')).toEqual(['no name "+ Add input flow"'])
  })
})

describe('shellWords', () => {
  it('splits like a shell', () => {
    expect(shellWords(`type "label=Name" bottle --enter`)).toEqual([
      'type',
      'label=Name',
      'bottle',
      '--enter'
    ])
    expect(shellWords(`wait text "css=.a b" "/^2(\\.0+)? kg/"`)).toEqual([
      'wait',
      'text',
      'css=.a b',
      '/^2(\\.0+)? kg/'
    ])
    expect(shellWords(`read 'document.title'`)).toEqual(['read', 'document.title'])
  })
})
