import { describe, expect, it, vi } from 'vitest'
import { localizeTools } from './localize'

const localize = localizeTools.find((t) => t.spec.function.name === 'localize_dataset')!

/** The copy endpoint's answer: the copy with one input and one biosphere flow. */
const COPY = {
  activity: { code: 'c1', name: 'steel production', location: 'RER' },
  exchanges: [
    { type: 'production', uid: 'p', amount: 1, input: { database: 'M', code: 'c1' } },
    {
      type: 'technosphere',
      uid: 'x1',
      amount: 2,
      input: { database: 'ei', code: 'elec', name: 'electricity', unit: 'kWh', location: 'DE' }
    },
    { type: 'biosphere', uid: 'b', amount: 1, input: { database: 'bio', code: 'co2' } }
  ],
  relinked: 1
}

/** A model whose process `frame` draws on ei/steel through the exchange `u1`. */
const MODEL = [
  {
    code: 'frame',
    exchanges: [
      { type: 'technosphere', uid: 'u1', input: { database: 'ei', code: 'steel' } },
      { type: 'technosphere', uid: 'own', input: { database: 'M', code: 'sub' } },
      { type: 'biosphere', uid: 'co2', input: { database: 'bio', code: 'co2' } }
    ]
  }
]

function ctx(copy: unknown = COPY) {
  const api = vi.fn(async (method: string, _path: string, _body?: unknown) =>
    method === 'GET' ? MODEL : copy
  )
  return { c: { api, activeDb: 'M' } as never, api }
}

const run = async (args: Record<string, unknown>, c = ctx()) =>
  JSON.parse((await localize.run(args, c.c)) as string)

describe('localize_dataset', () => {
  it('copies a dataset named by database and code, moving every input of the model that uses it', async () => {
    const c = ctx()
    const out = await run({ input_database: 'ei', input_code: 'steel' }, c)
    expect(c.api).toHaveBeenCalledWith(
      'POST',
      '/api/v1/model/activities/copy',
      expect.objectContaining({
        source_database: 'ei',
        source_code: 'steel',
        target_database: 'M',
        relink_consumers: true,
        depth: 1,
        source: 'ai'
      })
    )
    expect(c.api.mock.calls[0][2]).not.toHaveProperty('uids')
    expect(out).toMatchObject({ code: 'c1', relinked: 1, copied_from: { database: 'ei', code: 'steel' } })
    // The inputs carry the uid that localizes each in turn; biosphere flows are only counted.
    expect(out.inputs).toEqual([
      { uid: 'x1', name: 'electricity', location: 'DE', amount: 2, unit: 'kWh', database: 'ei', code: 'elec' }
    ])
    expect(out.biosphere_flows).toBe(1)
    expect(out).not.toHaveProperty('suppliers')
    expect(out.next).toContain('localize_dataset again')
  })

  it('finds the dataset behind a uid and moves only that input', async () => {
    const c = ctx()
    await run({ uid: 'u1', depth: 2 }, c)
    expect(c.api).toHaveBeenLastCalledWith(
      'POST',
      '/api/v1/model/activities/copy',
      expect.objectContaining({ source_database: 'ei', source_code: 'steel', uids: ['u1'], depth: 2 })
    )
  })

  it('lists the supplier copies at depth 2', async () => {
    const copy = {
      ...COPY,
      suppliers: [{ from: ['ei', 'elec'], code: 's1', name: 'electricity', location: 'DE' }]
    }
    const out = await run({ input_database: 'ei', input_code: 'steel', depth: 2 }, ctx(copy))
    expect(out.suppliers).toEqual([
      { code: 's1', name: 'electricity', location: 'DE', copied_from: { database: 'ei', code: 'elec' } }
    ])
    expect(out.next).toContain('"suppliers"')
  })

  it('says what to do when no input drew on the dataset yet', async () => {
    const out = await run({ input_database: 'ei', input_code: 'steel' }, ctx({ ...COPY, relinked: 0 }))
    expect(out.next).toContain('nothing uses the copy yet')
  })

  it('refuses what cannot be localized, without writing anything', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ input_code: 'steel' }, 'Say which dataset'],
      [{ uid: 'gone' }, 'No exchange with uid "gone"'],
      [{ uid: 'co2' }, 'biosphere flow'],
      [{ uid: 'own' }, 'already a process of "M"'],
      [{ input_database: 'M', input_code: 'sub' }, 'already a process of "M"'],
      [{ uid: 'u1', input_code: 'other' }, 'draws on ei/steel'],
      [{ input_database: 'ei', input_code: 'steel', depth: 3 }, '"depth" is 1 or 2']
    ]
    for (const [args, says] of cases) {
      const c = ctx()
      const out = await run(args, c)
      expect(out.error, JSON.stringify(args)).toContain(says)
      expect(c.api.mock.calls.some(([m]) => m === 'POST')).toBe(false)
    }
  })

  it('turns the supplier limit into the next step', async () => {
    const api = vi.fn(async () => {
      throw Object.assign(new Error("'steel' draws on 41 datasets directly"), { code: 'too_many_suppliers' })
    })
    const out = await run({ input_database: 'ei', input_code: 'steel', depth: 2 }, {
      c: { api, activeDb: 'M' } as never,
      api
    } as never)
    expect(out.error).toContain('41 datasets')
    expect(out.next).toContain('depth=1')
  })
})
