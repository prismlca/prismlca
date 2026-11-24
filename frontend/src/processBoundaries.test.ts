/**
 * The process boundaries in eslint.config.mjs, tried on one allowed and one forbidden import per side.
 *
 * The lint run over the real tree shows that nothing crosses a boundary today; this shows that the rules
 * would notice if something did, that the message names the way that works, and that tests (which run in
 * Node) stay free to read files.
 */
import { ESLint } from 'eslint'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const eslint = new ESLint({ cwd: join(__dirname, '..') })

// The first lint loads the config and the TypeScript parser — seconds on a loaded machine. It happens here,
// under its own limit, so that no single case below runs into the per-test timeout.
beforeAll(async () => {
  await eslint.lintText('\n', { filePath: join(__dirname, '..', 'src/shared/warmup.ts') })
}, 120_000)

/** The boundary messages for `code` linted as if it were the file `path`. */
async function boundaryMessages(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(__dirname, '..', path) })
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message)
}

const cases: [string, string, string | null][] = [
  // [file, import, a piece of the expected message — or null: allowed]
  ['src/renderer/src/views/Sample.tsx', "import { readFileSync } from 'node:fs'", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "import { join } from 'path'", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "import { ipcRenderer } from 'electron'", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "import { runAgent } from '../../../main/ai/agent'", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "await import('node:fs')", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "await import('fs/promises')", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "await import('../../../main/ai/agent')", 'window.prism'],
  ['src/renderer/src/views/Sample.tsx', "await import('./Heavy')", null],
  ['src/renderer/src/views/Sample.tsx', "import { DEFAULT_PLAN } from '../../../shared/plan'", null],
  ['src/renderer/src/views/Sample.tsx', "import { formatCount } from '../lib/format'", null],
  ['src/renderer/src/views/Sample.tsx', "import { useState } from 'react'", null],
  ['src/renderer/src/views/Sample.test.ts', "import { readFileSync } from 'node:fs'", null],
  ['src/shared/sample.ts', "import { app } from 'electron'", 'both processes'],
  ['src/shared/sample.ts', "import { join } from 'node:path'", 'both processes'],
  ['src/shared/sample.ts', "import { x } from '../renderer/src/lib/format'", 'both processes'],
  ['src/shared/sample.ts', "await import('electron')", 'both processes'],
  ['src/shared/sample.ts', "import { DEFAULT_PLAN } from './plan'", null],
  ['src/main/sample.ts', "import { x } from '../renderer/src/lib/format'", 'src/shared'],
  ['src/main/sample.ts', "await import('../renderer/src/lib/format')", 'src/shared'],
  ['src/main/sample.ts', "import { app } from 'electron'", null],
  ['src/main/sample.ts', "await import('node:fs')", null],
  ['src/main/sample.ts', "import { readFileSync } from 'node:fs'", null],
  ['src/preload/sample.ts', "import { contextBridge } from 'electron'", null]
]

describe('process boundaries', () => {
  for (const [path, code, expected] of cases) {
    it(`${expected ? 'refuses' : 'allows'} ${code} in ${path}`, async () => {
      const messages = await boundaryMessages(path, `${code}\n`)
      if (expected === null) expect(messages).toEqual([])
      else expect(messages).toEqual([expect.stringContaining(expected)])
    })
  }
})
