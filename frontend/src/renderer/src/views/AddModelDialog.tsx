import { useEffect, useMemo, useState } from 'react'

import EscapeCloser from '../components/EscapeCloser'
import { addUserModel, orCatalogue, type OrCatalogueRow } from '../lib/ai'
import { fmtInt } from '../lib/format'

/**
 * Pick a model from everything OpenRouter serves and add it to PrismLCA's list.
 *
 * Why a picker and not a text field: the id has to be exact, and a typo becomes a 404 in the
 * middle of a paid run. Everything shown here is measured rather than typed — name, price,
 * context and vision come from OpenRouter's own listing, and so does the column a user could not
 * possibly guess: whether the model has a zero-retention endpoint. Without one it cannot be served
 * while PrismLCA's privacy rule is on, so the dialog says that BEFORE the model is added rather than
 * letting the first use fail.
 *
 * OpenRouter only. The direct-OpenAI provider has no listing endpoint and no per-request price, so
 * there is nothing here to pick from and no way to bill what it costs.
 */
export default function AddModelDialog({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: () => void
}): JSX.Element {
  const [rows, setRows] = useState<OrCatalogueRow[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void orCatalogue()
      .then(setRows)
      .catch(() => setRows([]))
  }, [])

  const hits = useMemo(() => {
    if (!rows) return []
    const needle = q.trim().toLowerCase()
    const words = needle.split(/\s+/).filter(Boolean)
    const matched = words.length
      ? rows.filter((r) => {
          const hay = `${r.id} ${r.name}`.toLowerCase()
          return words.every((w) => hay.includes(w))
        })
      : rows
    // Addable first: the ones PrismLCA already offers are shown only so nobody searches twice for a
    // model that is there. No cap — an earlier one at 200 rows silently swallowed 237 of the 437
    // and left the footer reading "200 of 437" with no way to reach the rest. The flow picker
    // renders every match too; four hundred rows of three spans cost nothing.
    return [...matched].sort((a, b) => Number(a.inCatalogue) - Number(b.inCatalogue))
  }, [rows, q])

  const add = async (r: OrCatalogueRow): Promise<void> => {
    setBusy(r.id)
    setError('')
    const res = await addUserModel({
      id: r.id,
      label: r.name,
      vision: r.vision,
      // Only pass a window PrismLCA can actually serve; below its own output floor the loader refuses
      // the entry, and the default it picks instead is the safer answer.
      contextTokens: r.contextTokens && r.contextTokens >= 64_000 ? r.contextTokens : null
    })
    setBusy('')
    if (!res.ok || res.problems.length) {
      setError(res.problems[0] ?? 'Could not add the model.')
      return
    }
    onAdded()
    onClose()
  }

  // Two decimals would print every cheap model as "$0.00", and the cheap ones are exactly what a
  // picker like this is for — measured against the live list, prices run down to $0.087 per 1M.
  /**
   * Two decimals would print every cheap model as "$0.00", and the cheap ones are exactly what a
   * picker like this is for — measured against the live list, prices run down to $0.087 per 1M.
   * The precision is chosen once per PAIR, by the smaller number: "$0.800 / $1.20" reads like two
   * unrelated figures, "$0.800 / $1.200" like one price. And a free endpoint says so, instead of
   * printing "$0.000 / $0.000" and leaving the reader to work out that those zeroes are exact.
   */
  /** OpenRouter's moving pointers at a dated model. The leading `~` is its own marker for them;
   *  one id carries the `-latest` suffix without it, so both count. */
  const alias = (id: string): boolean => id.startsWith('~') || /-latest$/.test(id)

  const price = (r: OrCatalogueRow): string => {
    if (!r.pricing) return '–'
    const { input, output } = r.pricing
    if (input === 0 && output === 0) return 'free'
    const d = Math.min(input, output) < 1 ? 3 : 2
    return `$${input.toFixed(d)} / $${output.toFixed(d)}`
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div className="modal addmodel-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add a model</h3>
        <p className="props-sub">
          Everything OpenRouter serves. What you pick is added to your own list and marked as yours — PrismLCA
          does not rate it, and its price comes from OpenRouter like any other.
        </p>
        <input
          className="flowpick-search"
          autoFocus
          placeholder="Search by name or id… (e.g. mistral, qwen/qwen3.8-max)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {error ? <p className="settings-hint bad">{error}</p> : null}
        <div className="flowpick-list addmodel-list">
          {rows === null ? (
            <p className="empty">Loading OpenRouter's model list…</p>
          ) : hits.length === 0 ? (
            <p className="empty">
              {rows.length === 0
                ? "OpenRouter's list could not be fetched — check the API key under Provider."
                : 'No model matches.'}
            </p>
          ) : (
            hits.map((r) => (
              <button
                key={r.id}
                className="flowpick-row addmodel-row"
                disabled={r.inCatalogue || busy === r.id}
                onClick={() => void add(r)}
                title={r.id}
              >
                <span className="fp-name">
                  {r.name}
                  <span className="addmodel-id">{r.id}</span>
                </span>
                <span className="fp-cat addmodel-facts">
                  {r.contextTokens ? `${fmtInt(Math.round(r.contextTokens / 1000))}k ctx` : ''}
                  {r.vision ? ' · vision' : ''}
                  {/* The column that decides whether it will work at all under the default privacy
                      rule — stated here, not discovered on the first paid run.
                      "listed" is the honest word. OpenRouter's ZDR list enumerates concrete models
                      (measured: 244 of 437 are on it). An ALIAS id is never on it, even
                      when the model behind it retains nothing — all 14 of the `…-latest` ids are
                      absent for that reason alone. So absence means "no", except where it means
                      "cannot tell", and the tooltip says which. */}
                  {r.zdr !== false ? null : (
                    <span
                      className="addmodel-nozdr"
                      title={
                        alias(r.id)
                          ? 'This is an alias that follows whichever model is current. Zero retention is listed per concrete model, never per alias, so it cannot be determined here — and the context window shown will not follow the alias when it moves. Pick the dated id if either matters.'
                          : 'OpenRouter lists no zero-retention endpoint for this model. It cannot be served while the privacy rule is on, unless its vendor is exempted.'
                      }
                    >
                      {' '}
                      · no zero-retention endpoint listed
                    </span>
                  )}
                </span>
                <span className="fp-unit">{r.inCatalogue ? 'already listed' : price(r)}</span>
              </button>
            ))
          )}
        </div>
        <p className="settings-hint">
          Price is input / output per 1M tokens. Every model OpenRouter serves is listed, including ones whose
          providers train on prompts — your privacy rule keeps every request away from them, whichever model
          you pick. The mark is about the stricter second rule, zero retention, which some models cannot meet.
          Only that rule is published as a list, so a model can still prove unreachable on first use — the
          error then names the setting.
        </p>
        <div className="flowpick-foot">
          {/* "437 of 437" is noise; the count only earns the comparison once something is filtered. */}
          <span className="fp-sel">
            {!rows
              ? ''
              : hits.length === rows.length
                ? `${rows.length} models`
                : `${hits.length} of ${rows.length} models`}
          </span>
          {/* `sm` like the sheet's own Close behind it: the same word at two sizes in two stacked
              windows reads as two different controls. */}
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
