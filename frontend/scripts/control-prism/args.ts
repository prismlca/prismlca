/** The command line's words: a command, its positional arguments, and `--flags` (`--name value` or `--name=value`). */

/** Flags that take no value; every other flag takes the next word. */
export const SWITCHES = new Set([
  'right',
  'double',
  'append',
  'enter',
  'commit',
  'exact',
  'all',
  'keep',
  'full',
  'fresh',
  'seed',
  'copy',
  'keys',
  'sealed',
  'full-copy',
  'no-build',
  'options',
  'help'
])
export const VALUED = new Set([
  'session',
  'timeout',
  'target',
  'since',
  'idle',
  'from-offset',
  'to-offset',
  'steps',
  'minutes',
  'runs',
  'control'
])

export interface Parsed {
  cmd: string
  args: string[]
  flags: Record<string, string | true>
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Parsed {
  const args: string[] = []
  const flags: Record<string, string | true> = {}
  let literal = false
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (literal || !word.startsWith('--') || word === '--') {
      if (word === '--' && !literal) literal = true
      else args.push(word)
      continue
    }
    const eq = word.indexOf('=')
    const name = word.slice(2, eq < 0 ? undefined : eq)
    if (SWITCHES.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`)
      flags[name] = true
    } else if (VALUED.has(name)) {
      const value = eq >= 0 ? word.slice(eq + 1) : argv[++i]
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
      flags[name] = value
    } else {
      throw new UsageError(`unknown flag --${name}. A text that starts with "--" goes after a bare "--".`)
    }
  }
  const [cmd = 'help', ...rest] = args
  return { cmd, args: rest, flags }
}
