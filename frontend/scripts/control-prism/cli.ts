/**
 * control-prism — drive the built PrismLCA app the way a person does, from a shell, one command at a time.
 * Run from `frontend/`: `node scripts/control-prism.mjs <command>`; `help` lists the commands. The feature
 * map in `frontend/features/` says what to drive on each page and what counts as proof.
 *
 * This file reads the command and hands it on: session commands to lifecycle.ts, the driving commands to
 * the session's host (host.ts) through client.ts, and doctor's judgement to doctor.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FRONTEND } from '../../e2e/app'
import { listProcesses } from '../../e2e/processes'
import { parseArgs, UsageError, type Parsed } from './args'
import { backendFingerprint, build, outFingerprint, readStamp, sourceFingerprint } from './build'
import { Exit, out, requireSession, send } from './client'
import { changedSince, judge, realDirs } from './doctor'
import type { AppFacts } from './facts'
import { hostAlive, runHost } from './host'
import { launch, restart, stop } from './lifecycle'
import { controlDir, readSession, sessionName, type SessionRecord } from './session'
import { TargetError } from './targets'
import { WAIT_HELP } from './waits'

const HELP = `control-prism — drive the built app like a person, for proof that a change works.
Run from frontend/:  node scripts/control-prism.mjs <command> [--session <name>]

session
  launch [--fresh] [--seed] [--copy [--full-copy]] [--keys] [--no-build] [--idle <min>]
                     build out/ if it is not the current source, start a fresh isolated instance;
                     --seed imports the BAFU test fixture through the setup sheet (preparation only);
                     --copy starts on a copy of your own data and profile instead (blocks shared with
                     yours where the disk can; --full-copy copies in full where it cannot);
                     --keys copies your stored provider keys in: chats then bill your accounts
  doctor             is the running app a valid witness? run it before every proof; exit 1 if not
  status             the session's record
  restart [--no-build]   quit and start again on the same data (rebuilds out/ first if the sources changed)
  stop [--keep]      quit the app, end what it started, remove its folders (--keep keeps them,
                     without stored keys)
  build              build out/ and stamp it (launch does this when needed)

driving                              (<target>: see "targets" below)
  click <target> [--right] [--double]
  hover <target>
  type <target> <text> [--append] [--enter] [--commit]   --commit leaves the field (blur commits)
  press <keys>… [--target <target>]                      e.g. press Control+z · press Tab Enter
  select <target> <option label>
  wait <condition> … [--timeout <ms>]                    see "wait" below
  console [--all] [--since <n>]      the window's errors since launch (or since message n); exit 1 if any
  snapshot [--target <target>] [--options]   the accessibility tree: roles and names, as targets use them
  shot [<file.png>] [--target <target>] [--full]
  read '<expression>'                look at state in the window; never the proof, never a wait loop

targets, strongest first:  Run (exact aria-label) · role=button:Calculate · title=Settings ·
  label=Workspace name · placeholder=… · text=… · css=.chat-send.stop
  ~= matches a substring, /…/ is a regular expression, " >> " narrows: css=.chat-panel >> title=Collapse,
  then has-text=…, visible, nth=0

wait
${WAIT_HELP.split('\n')
  .map((l) => '  ' + l)
  .join('\n')}

Every session belongs to the checkout that launched it (--session or CONTROL_PRISM_SESSION picks one of
several; default "default"). Its logs are in .cache/control-prism/logs/<session>/. Native dialogs (file
pickers, OAuth) are manual: they are not driven.`

function bundlePath(): string {
  // The command line runs as one bundle in .cache/; FRONTEND (e2e/app.ts) is computed from its folder.
  const bundle = resolve(__filename)
  if (
    !existsSync(join(FRONTEND, 'package.json')) ||
    !existsSync(join(FRONTEND, 'scripts', 'control-prism'))
  ) {
    throw new Exit(
      2,
      `control-prism must run as frontend/.cache/control-prism.cjs (got ${bundle}); start it with node scripts/control-prism.mjs`
    )
  }
  return bundle
}

/** The checkout's own provider key files, which a driven instance must not read. */
function devKeyFiles(): string[] {
  const dir = join(FRONTEND, '..', '.secrets')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('-key'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** The settings a developer's backend/.env sets — names only, never values. */
function backendEnvKeys(): string[] {
  try {
    return readFileSync(join(FRONTEND, '..', 'backend', '.env'), 'utf8')
      .split('\n')
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter((k): k is string => !!k)
  } catch {
    return []
  }
}

async function doctorCmd(record: SessionRecord): Promise<void> {
  const real = realDirs()
  let app: AppFacts | null = null
  let hostError: string | undefined
  try {
    app = JSON.parse(await send(record, 'facts', [], {})) as AppFacts
  } catch (e) {
    hostError = (e as Error).message
  }
  const fresh = readSession(FRONTEND, record.name) ?? record
  const checks = judge({
    frontend: FRONTEND,
    record: fresh,
    app,
    hostError,
    current: {
      src: sourceFingerprint(FRONTEND),
      out: outFingerprint(FRONTEND),
      backend: backendFingerprint(FRONTEND)
    },
    stamp: readStamp(FRONTEND),
    realDirs: real,
    realChanged: changedSince(real, Date.parse(record.launchedAt)),
    devKeyFiles: devKeyFiles(),
    backendEnvKeys: backendEnvKeys()
  })
  out(`doctor — session "${record.name}", ${FRONTEND}`)
  for (const c of checks) out(`  ${c.status.padEnd(4)}  ${c.text}`)
  const failed = checks.filter((c) => c.status === 'FAIL').length
  if (failed > 0) throw new Exit(1, `NOT a valid witness: ${failed} check(s) failed`)
  out('a valid witness for this checkout')
}

async function consoleCmd(record: SessionRecord, flags: Parsed['flags']): Promise<void> {
  const { last, entries } = JSON.parse(await send(record, 'console', [], flags)) as {
    last: number
    entries: { n: number; type: string; text: string }[]
  }
  for (const e of entries) out(`#${e.n} ${e.type}: ${e.text}`)
  const errors = entries.filter((e) => e.type === 'error' || e.type === 'pageerror').length
  out(
    `${errors} error(s)${flags.since ? ` since #${String(flags.since)}` : ' since launch'}; latest message #${last} — --since ${last} shows only what comes next`
  )
  if (errors > 0) throw new Exit(1, 'the window logged errors')
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === '__host') {
    await runHost(FRONTEND, argv[1])
    return
  }
  const p = parseArgs(argv)
  if (p.cmd === 'help' || p.flags.help) {
    out(HELP)
    return
  }
  const name = sessionName(typeof p.flags.session === 'string' ? p.flags.session : undefined)
  switch (p.cmd) {
    case 'build':
      build(FRONTEND, out)
      return
    case 'launch':
      return launch(name, bundlePath(), p.flags)
    case 'status': {
      const r = requireSession(name)
      out(JSON.stringify({ ...r, token: undefined, hostAlive: hostAlive(r, listProcesses()) }, null, 2))
      return
    }
    case 'restart':
      out(await restart(requireSession(name), p.flags))
      return
    case 'stop':
      ;(await stop(requireSession(name), p.flags)).forEach(out)
      return
    case 'doctor':
      return doctorCmd(requireSession(name))
    case 'console':
      return consoleCmd(requireSession(name), p.flags)
    case 'shot': {
      const r = requireSession(name)
      const file = p.args[0] ?? join(controlDir(FRONTEND), 'shots', `${name}-${Date.now()}.png`)
      mkdirSync(join(controlDir(FRONTEND), 'shots'), { recursive: true })
      out(await send(r, 'shot', [resolve(file)], p.flags))
      return
    }
    case 'click':
    case 'hover':
    case 'type':
    case 'press':
    case 'select':
    case 'wait':
    case 'snapshot':
    case 'read': {
      const r = requireSession(name)
      if (p.cmd === 'read')
        process.stderr.write('read looks at state; it is not proof that the user path works\n')
      out(await send(r, p.cmd, p.args, p.flags))
      return
    }
    default:
      throw new Exit(2, `unknown command "${p.cmd}" — help lists them`)
  }
}

main(process.argv.slice(2)).then(
  () => {
    if (process.argv[2] !== '__host') process.exit(0)
  },
  (e: unknown) => {
    const code = e instanceof Exit ? e.code : e instanceof UsageError || e instanceof TargetError ? 2 : 1
    process.stderr.write(`error: ${(e as Error).message}\n`)
    process.exit(code)
  }
)
