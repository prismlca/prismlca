/**
 * A stateful fake of the backend's exchange endpoints, for tests that drive edit_exchange end to end and
 * then look at what the model holds: which exchanges exist on which process, and what each call wrote.
 * Every formula "evaluates" to 42 — the tests care which exchange was written, not the number.
 */
import type { ToolCtx } from '../tools/context'

export interface FakeExchange {
  uid: string
  activity: string
  amount: number
  formula: string | null
  comment: string | null
  type: string
  input: { database: string; code: string }
}

export function fakeExchanges(
  db: string,
  seed: Array<Omit<FakeExchange, 'formula' | 'comment' | 'type'> & Partial<FakeExchange>>
) {
  const store = new Map<string, FakeExchange>()
  for (const e of seed) store.set(e.uid, { formula: null, comment: null, type: 'technosphere', ...e })
  const writes: Array<[string, any]> = []
  let n = 0
  const copy = (e: FakeExchange): FakeExchange => JSON.parse(JSON.stringify(e))
  const on = (activity: string): FakeExchange[] => [...store.values()].filter((e) => e.activity === activity)
  const api = async (method: string, path: string, body: any): Promise<any> => {
    if (method === 'POST') writes.push([path, body])
    if (path === '/api/v1/model/exchanges') {
      const uid = `new${++n}`
      store.set(uid, {
        uid,
        activity: body.activity_code,
        amount: body.amount,
        formula: null,
        comment: null,
        type: body.type ?? 'technosphere',
        input: { database: body.input_database, code: body.input_code }
      })
      return { exchange: copy(store.get(uid)!) }
    }
    const edit = (patch: Partial<FakeExchange>): any => {
      const e = store.get(body.uid)
      if (!e) throw new Error(`Exchange ${body.uid} not found.`)
      Object.assign(e, patch)
      return { exchange: copy(e) }
    }
    if (path === '/api/v1/model/exchanges/amount') return edit({ amount: body.amount, formula: null })
    if (path === '/api/v1/params/evaluate') return { value: 42 }
    if (path === '/api/v1/params/exchange-formula') return edit({ formula: body.formula, amount: 42 })
    if (path === '/api/v1/model/exchanges/comment') return edit({ comment: body.comment })
    if (path === '/api/v1/model/exchanges/remove') {
      store.delete(body.uid)
      return { ok: true }
    }
    const prefix = `/api/v1/model/activities/${encodeURIComponent(db)}`
    if (path === `${prefix}?with_exchanges=true`) {
      const codes = [...new Set([...store.values()].map((e) => e.activity))]
      return codes.map((code) => ({ code, exchanges: on(code).map(copy) }))
    }
    if (path.startsWith(`${prefix}/`)) {
      const code = decodeURIComponent(path.slice(prefix.length + 1))
      return { activity: { code }, exchanges: on(code).map(copy) }
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  const ctx = { api, ui: async () => ({}), activeDb: db } as unknown as ToolCtx
  return { store, writes, ctx, on }
}
