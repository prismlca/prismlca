import { useEffect, useMemo, useState } from 'react'
import { aiOpenRouterPrices, KEY_CHANGED_EVENT, type AiModelInfo } from '../../lib/ai'

type Price = { input: number; output: number }

/**
 * OpenRouter's live prices for the Models table, loaded after the catalogue rather than with it.
 *
 * The catalogue answers at once; the prices are a lookup per model at OpenRouter (main/ai/providers/
 * openrouterListings.ts), and nothing but this table shows them — the chat's model choice and the cost
 * ledger read the same catalogue and must not wait for, or cause, that lookup. Asked again whenever the
 * set of OpenRouter models changes (a model added or removed) or a key is entered or removed — the key
 * field is one page away and the table may be open — and only while `enabled`: the table shows
 * OpenRouter's rows only while OpenRouter is the provider. Rows that already carry a price — the
 * hand-kept list prices of the direct providers — keep it.
 */
export function useLivePrices(
  models: AiModelInfo[],
  enabled: boolean
): { rows: AiModelInfo[]; loading: boolean } {
  const [prices, setPrices] = useState<Record<string, Price>>({})
  const [loading, setLoading] = useState(false)
  // Bumped by every key change; the main process decides what a key means (no key, no prices).
  const [keyGen, setKeyGen] = useState(0)
  useEffect(() => {
    const bump = (): void => setKeyGen((g) => g + 1)
    window.addEventListener(KEY_CHANGED_EVENT, bump)
    return () => window.removeEventListener(KEY_CHANGED_EVENT, bump)
  }, [])
  // The OpenRouter ids as one string: a new array with the same models must not ask again.
  const ids = enabled
    ? models
        .filter((m) => (m.provider ?? 'openrouter') === 'openrouter')
        .map((m) => m.id)
        .join('\n')
    : ''

  // One request per change of ids or key; the cleanup retires the previous one, so an answer that comes
  // back late never overwrites a newer one.
  useEffect(() => {
    if (!ids) {
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    void aiOpenRouterPrices()
      .then((p) => {
        if (live) setPrices(p)
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [ids, keyGen])

  const rows = useMemo(
    () => models.map((m) => (m.pricing || !prices[m.id] ? m : { ...m, pricing: prices[m.id] })),
    [models, prices]
  )
  return { rows, loading }
}
