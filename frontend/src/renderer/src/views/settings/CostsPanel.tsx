import { useEffect, useState } from 'react'
import { aiModels, aiUsage, type AiModelInfo, type UsageEntry } from '../../lib/ai'
import { getAS } from '../../lib/appSettings'
import { fmtTokens, fmtUsd, monthLabel } from '../../lib/money'
import { LAB_LOGOS, labKey } from '../../lib/labLogos'
import type { ProviderChoice } from './ProviderKeyBlock'

/** Which provider a LEDGER row belongs to: bare ids are direct-OpenAI by construction (see labKey);
 *  everything with a vendor prefix — `openai/whisper-large-v3` included — was billed via OpenRouter. */
const rowProvider = (id: string): ProviderChoice => (id.includes('/') ? 'openrouter' : 'openai')

/** API-cost ledger: models as rows (with lab logo), months as columns, real OpenRouter USD. */
export function CostsPanel(): JSX.Element {
  const [usage, setUsage] = useState<Record<string, Record<string, UsageEntry>>>({})
  const [models, setModels] = useState<AiModelInfo[]>([])
  // Tabs over the TABLE only — the tiles and the category line above stay whole-app totals. Starts
  // on the active provider, because "what did my current setup cost" is the question walked in with.
  const [tab, setTab] = useState<ProviderChoice>(() =>
    getAS().provider === 'openai' ? 'openai' : 'openrouter'
  )
  useEffect(() => {
    void aiUsage()
      .then(setUsage)
      .catch(() => {})
    void aiModels()
      .then(setModels)
      .catch(() => {})
  }, [])

  const months = Object.keys(usage).sort() // ascending: oldest left, newest right
  const modelIds = Array.from(new Set(months.flatMap((m) => Object.keys(usage[m]))))
  const cell = (m: string, id: string): UsageEntry | undefined => usage[m][id]
  const sumOf = (id: string, field: 'cost' | 'prompt' | 'cached' | 'completion' | 'calls'): number =>
    months.reduce((s, m) => s + (cell(m, id)?.[field] ?? 0), 0)
  const totalOf = (id: string): number => sumOf(id, 'cost')
  modelIds.sort((a, b) => totalOf(b) - totalOf(a))
  const monthTotal = (m: string): number => Object.values(usage[m]).reduce((s, v) => s + v.cost, 0)
  const grandTotal = months.reduce((s, m) => s + monthTotal(m), 0)
  const thisMonth = months[months.length - 1]
  // The table's slice: rows of the selected tab, only the months that slice has data for, and the
  // bar scale computed WITHIN the slice — a $6 OpenRouter month must not flatten a $0.20 OpenAI one.
  const tabIds = modelIds.filter((id) => rowProvider(id) === tab)
  const tabMonths = months.filter((m) => tabIds.some((id) => cell(m, id)))
  const maxCell = Math.max(...tabMonths.flatMap((m) => tabIds.map((id) => cell(m, id)?.cost ?? 0)), 0) || 1
  // Share of the prompt the provider served from its own prefix cache. Worth showing: it varies
  // enormously between providers (19% vs 87% measured over the same tasks), and a high share is why
  // a long conversation stays affordable.
  const cachedPct = (id: string): number | null => {
    const prompt = sumOf(id, 'prompt')
    return prompt ? Math.round((sumOf(id, 'cached') / prompt) * 100) : null
  }
  // What kind of work the money went into (V127): modelling chats, report writing, embeddings,
  // speech. Summed across all months and models; entries recorded before the split have no shares
  // and appear as the difference to the grand total.
  const categoryTotals = (() => {
    const totals: Record<string, { cost: number; prompt: number }> = {}
    for (const m of months) {
      for (const entry of Object.values(usage[m])) {
        for (const [name, share] of Object.entries(entry.categories ?? {})) {
          const t = (totals[name] ??= { cost: 0, prompt: 0 })
          t.cost += share?.cost ?? 0
          t.prompt += share?.prompt ?? 0
        }
      }
    }
    return totals
  })()
  const splitTitle = (m: string, id: string): string | undefined => {
    const categories = cell(m, id)?.categories
    if (!categories) return undefined
    return Object.entries(categories)
      .map(([name, share]) =>
        share?.cost ? `${name} ${fmtUsd(share.cost)}` : `${name} ${fmtTokens(share?.prompt ?? 0)} tokens`
      )
      .join(' · ')
  }

  return (
    <>
      <h4>API costs</h4>
      <p className="settings-hint">
        Cost (USD) per request, summed per model and month — as reported by OpenRouter, and computed from list
        prices under the OpenAI provider (estimates). The prompt-cache discount is already included. “Cached”
        is the share of prompt tokens the provider served from its cache instead of charging in full.
      </p>
      {modelIds.length === 0 ? (
        <p className="empty" style={{ padding: 0 }}>
          No API costs recorded yet.
        </p>
      ) : (
        <>
          <div className="cost-stats">
            <div className="cost-stat">
              <div className="cost-stat-num">{fmtUsd(thisMonth ? monthTotal(thisMonth) : 0)}</div>
              <div className="cost-stat-label">{thisMonth ? monthLabel(thisMonth) : 'this month'}</div>
            </div>
            <div className="cost-stat">
              <div className="cost-stat-num">{fmtUsd(grandTotal)}</div>
              <div className="cost-stat-label">all time</div>
            </div>
            <div className="cost-stat">
              <div className="cost-stat-num">{modelIds.length}</div>
              <div className="cost-stat-label">models used</div>
            </div>
            {/* What kind of work the money went into (V127) — the same tile grammar as the three
                totals beside them, because they answer the same at-a-glance question. All time. */}
            {Object.entries(categoryTotals)
              .sort(([, a], [, b]) => b.cost - a.cost)
              .map(([name, ct]) => (
                <div className="cost-stat" key={name} title="all time">
                  <div className="cost-stat-num">
                    {ct.cost ? fmtUsd(ct.cost) : `${fmtTokens(ct.prompt)} tokens`}
                  </div>
                  <div className="cost-stat-label">{name}</div>
                </div>
              ))}
            {/* Whatever was booked before the category split existed, so the category tiles visibly
                add up to "all time" instead of silently falling short of it. */}
            {(() => {
              const categorised = Object.values(categoryTotals).reduce((sum, ct) => sum + ct.cost, 0)
              const rest = grandTotal - categorised
              return Object.keys(categoryTotals).length && rest > 0.005 ? (
                <div
                  className="cost-stat"
                  title="Booked before the per-category split existed (mid-August 2026) — real spend, just without a category."
                >
                  <div className="cost-stat-num">{fmtUsd(rest)}</div>
                  <div className="cost-stat-label">uncategorised</div>
                </div>
              ) : null
            })()}
          </div>
          {Object.keys(categoryTotals).length ? (
            <p className="settings-hint">
              Category tiles are all-time and add up to it — “uncategorised” is spend booked before the
              per-category split existed. Hover a table cell for its month’s split.
            </p>
          ) : null}
          <div className="seg" role="tablist" aria-label="Provider" style={{ marginBottom: 8 }}>
            <button
              type="button"
              className={`seg-btn${tab === 'openrouter' ? ' on' : ''}`}
              onClick={() => setTab('openrouter')}
            >
              OpenRouter
            </button>
            <button
              type="button"
              className={`seg-btn${tab === 'openai' ? ' on' : ''}`}
              onClick={() => setTab('openai')}
            >
              OpenAI
            </button>
          </div>
          {tabIds.length === 0 ? (
            <p className="empty" style={{ padding: 0 }}>
              No costs recorded for this provider yet.
            </p>
          ) : (
            <div className="ai-table-wrap">
              <table className="ai-table cost-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    {tabMonths.map((m) => (
                      <th className="num" key={m}>
                        {monthLabel(m)}
                      </th>
                    ))}
                    <th className="num">Total</th>
                    <th className="num">Prompt tokens</th>
                    <th className="num">Cached</th>
                    <th
                      className="num"
                      title="Output tokens, reasoning included — where the price of a short prompt usually sits."
                    >
                      Output tokens
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tabIds.map((id) => {
                    const info = models.find((mo) => mo.id === id)
                    const lab = labKey(id)
                    const logo = LAB_LOGOS[lab]
                    return (
                      <tr key={id}>
                        <td className="cost-model" title={id}>
                          {logo ? <img className="cost-logo" src={logo} alt={lab} /> : null}
                          {info?.label ?? id}
                        </td>
                        {tabMonths.map((m) => {
                          const v = cell(m, id)?.cost
                          return (
                            <td className="num cost-cell" key={m} title={splitTitle(m, id)}>
                              {v != null ? (
                                <>
                                  <span
                                    className="cost-bar"
                                    style={{ width: `${Math.max(4, Math.round((v / maxCell) * 100))}%` }}
                                  />
                                  {fmtUsd(v)}
                                </>
                              ) : (
                                <span className="cost-none">–</span>
                              )}
                            </td>
                          )
                        })}
                        <td className="num">
                          <b>{fmtUsd(totalOf(id))}</b>
                        </td>
                        <td className="num">
                          {sumOf(id, 'prompt') ? (
                            fmtTokens(sumOf(id, 'prompt'))
                          ) : (
                            <span className="cost-none">–</span>
                          )}
                        </td>
                        <td className="num">
                          {cachedPct(id) != null ? `${cachedPct(id)}%` : <span className="cost-none">–</span>}
                        </td>
                        {/* Output tokens, reasoning included. Without them a correction that billed 13×
                          as much per prompt token as the chapter it corrected had no explanation
                          anywhere in the app (V127's other half). Entries
                          written before this existed show "–": not measured, not zero. */}
                        <td className="num">
                          {sumOf(id, 'completion') ? (
                            fmtTokens(sumOf(id, 'completion'))
                          ) : (
                            <span className="cost-none">–</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="cost-total">
                    <td>Total</td>
                    {tabMonths.map((m) => (
                      <td className="num" key={m}>
                        <b>{fmtUsd(tabIds.reduce((sum, id) => sum + (cell(m, id)?.cost ?? 0), 0))}</b>
                      </td>
                    ))}
                    <td className="num">
                      <b>{fmtUsd(tabIds.reduce((sum, id) => sum + totalOf(id), 0))}</b>
                    </td>
                    <td className="num" />
                    <td className="num" />
                    <td className="num" />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}
