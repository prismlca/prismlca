import { describe, expect, it } from 'vitest'
import { groupErrors, unhandledErrors } from './backendLog'

// The shape of the session's app.log: the backend's records prefixed with [backend], a traceback after the
// "Unhandled error" record, then uvicorn's own report of the same request.
const traceback = (n: number): string[] => [
  '[backend] ERROR: [prism_lca.api.error_handlers] Unhandled error',
  'Traceback (most recent call last):',
  '  File "/venv/lib/python3.12/site-packages/starlette/middleware/errors.py", line 164, in __call__',
  '    await self.app(scope, receive, _send)',
  `  File "/wt/backend/src/prism_lca/api/v1/calc.py", line ${n}, in contribution`,
  '    out = lca.contribution(',
  '          ^^^^^^^^^^^^^^^^^',
  '  File "/wt/backend/src/prism_lca/engine/lca.py", line 143, in get_lca',
  '    lca.lcia()  # build the characterisation matrix + first score',
  '    ^^^^^^^^^^',
  '  File "/venv/lib/python3.12/site-packages/bw2calc/lca_base.py", line 205, in lcia',
  '    raise EmptyBiosphere',
  'bw2calc.errors.EmptyBiosphere',
  '[backend] ERROR:    Exception in ASGI application',
  'Traceback (most recent call last):',
  '  File "/venv/lib/python3.12/site-packages/uvicorn/protocols/http/httptools_impl.py", line 422, in run_asgi',
  'bw2calc.errors.EmptyBiosphere'
]

const LOG = [
  '[backend] INFO: [prism_lca.search] ready',
  '[sealed] refused: link https://example.org',
  ...traceback(266),
  "Error occurred in handler for 'news:fetch': Error: prismlca.com could not be reached.",
  '    at fetchNewsFeed (/out/main/index.js:46481:11)',
  ...traceback(266),
  '[backend] ERROR: [prism_lca.api.error_handlers] Unhandled error',
  'Traceback (most recent call last):',
  '  File "/wt/backend/src/prism_lca/api/v1/models.py", line 12, in rename',
  '    raise KeyError(name)',
  "KeyError: 'a/b'"
].join('\n')

describe('the backend log', () => {
  it('finds every Unhandled error with its exception and the innermost frame of our own code', () => {
    const errors = unhandledErrors(LOG)
    expect(errors.map((e) => e.exception)).toEqual([
      'bw2calc.errors.EmptyBiosphere',
      'bw2calc.errors.EmptyBiosphere',
      "KeyError: 'a/b'"
    ])
    expect(errors[0].line).toBe(3)
    expect(errors[0].where).toBe('engine/lca.py:143 in get_lca')
    expect(errors[2].where).toBe('api/v1/models.py:12 in rename')
    // Our frames with their source line, no third-party frames, the exception last.
    expect(errors[0].traceback).toEqual([
      '  File "/wt/backend/src/prism_lca/api/v1/calc.py", line 266, in contribution',
      '    out = lca.contribution(',
      '  File "/wt/backend/src/prism_lca/engine/lca.py", line 143, in get_lca',
      '    lca.lcia()  # build the characterisation matrix + first score',
      'bw2calc.errors.EmptyBiosphere'
    ])
  })

  it('does not count what is no Unhandled error: uvicorn repeating it, the main process, the seal', () => {
    expect(unhandledErrors(traceback(1).slice(13).join('\n'))).toEqual([])
    expect(unhandledErrors("Error occurred in handler for 'x': Error: y\n[sealed] refused: z")).toEqual([])
  })

  it('finds an error that starts mid-chunk without the prefix, and follows a traceback across two chunks', () => {
    // The main process prefixes each stderr chunk, trimmed, not each record.
    const log = [
      '[backend] INFO: [prism_lca.search] index ready',
      'ERROR: [prism_lca.api.error_handlers] Unhandled error',
      'Traceback (most recent call last):',
      '  File "/wt/backend/src/prism_lca/api/v1/models.py", line 12, in rename',
      '    store(name)',
      '[backend] File "/wt/backend/src/prism_lca/engine/store.py", line 40, in store',
      '    raise KeyError(name)',
      "KeyError: 'a/b'",
      '[backend] ERROR: [prism_lca.api.error_handlers] Unhandled error',
      'Traceback (most recent call last):',
      '  File "/wt/backend/src/prism_lca/api/v1/calc.py", line 9, in lcia',
      '    raise ValueError("x")',
      'ValueError: x',
      'INFO: [prism_lca.search] the next record, in the same chunk'
    ].join('\n')
    const errors = unhandledErrors(log)
    expect(errors.map((e) => [e.line, e.exception, e.where])).toEqual([
      [2, "KeyError: 'a/b'", 'engine/store.py:40 in store'],
      [9, 'ValueError: x', 'api/v1/calc.py:9 in lcia']
    ])
  })

  it('counts the same error from the same place once, with how often it came', () => {
    expect(groupErrors(unhandledErrors(LOG))).toEqual([
      {
        exception: 'bw2calc.errors.EmptyBiosphere',
        where: 'engine/lca.py:143 in get_lca',
        count: 2,
        firstLine: 3
      },
      { exception: "KeyError: 'a/b'", where: 'api/v1/models.py:12 in rename', count: 1, firstLine: 39 }
    ])
  })
})
