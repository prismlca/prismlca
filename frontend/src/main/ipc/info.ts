/**
 * The read-only info surface behind the Settings pages: the tool catalog, the model catalog with
 * pricing, and the accumulated cost ledger. Its own module rather than part of chat or keys because
 * it shares nothing with either — no run state, no secrets — and everything here is display data.
 */
import { ipcMain } from 'electron'

import { fetchPricing, getApiKey } from '../ai/client'
import {
  clearPriceCache,
  fetchOpenRouterCatalogue,
  fetchOpenRouterProviders
} from '../ai/providers/openrouterListings'
import {
  BUILTIN_IDS,
  getModels,
  getUserModelProblems,
  getUserModels,
  setUserModels,
  type AiModel
} from '../ai/models'
import { priceOn } from '../ai/directModels'
import { PROVIDER_CAPS } from '../../shared/providerCaps'
import { loadUserModels, userDataDir, userModelsPath, writeUserModels } from '../ai/userModels'
import { toolCatalog } from '../ai/tools'
import { getUsage } from '../ai/usage'
import type { AiIpcDeps } from './shared'

export function registerInfoIpc(deps: AiIpcDeps): void {
  // Renderer → main: the accumulated API-cost ledger (month → model → USD). The embeddings bill
  // from the backend, not from here, so their half of the ledger is fetched and merged in as the
  // 'embedding' category (V127) — best-effort, the table must show even when the backend is down.
  ipcMain.handle('ai:usage', async () => {
    const usage = structuredClone(getUsage())
    try {
      const { status, body } = await deps.apiRequest('GET', '/api/v1/system/embedding-usage')
      const months = status < 400 ? (body as { months?: Record<string, Record<string, any>> })?.months : null
      for (const [month, models] of Object.entries(months ?? {})) {
        for (const [id, raw] of Object.entries(models ?? {})) {
          const share = {
            cost: Number(raw?.cost) || 0,
            prompt: Number(raw?.prompt) || 0,
            cached: 0,
            calls: Number(raw?.calls) || 0
          }
          if (!share.cost && !share.prompt) continue
          const bucket = (usage[month] ??= {})
          const entry = (bucket[id] ??= { cost: 0, prompt: 0, cached: 0, calls: 0 })
          entry.cost += share.cost
          entry.prompt += share.prompt
          entry.calls += share.calls
          ;(entry.categories ??= {}).embedding = share
        }
      }
    } catch {
      // The backend may still be starting — the main ledger alone is a complete answer.
    }
    return usage
  })

  // Renderer → main: what PrismLCA refused in the user's own models.json, one line each. Its own
  // channel rather than a field on ai:models, so the three call sites of that array stay as they
  // are — and because this is a diagnostic, not part of the catalogue.
  ipcMain.handle('ai:modelIssues', () => getUserModelProblems())

  // Renderer → main: OpenRouter's whole model list for the "Add model" dialog — name, price,
  // context, vision and, the column that decides usability, whether a zero-retention endpoint
  // exists at all.
  ipcMain.handle('ai:openrouterCatalogue', async () => {
    // No key, no request (privacy rule: nothing leaves the machine before the user has
    // acted). Without a key the dialog could not add a usable model anyway, and its empty state already
    // says "check the API key".
    const key = getApiKey('openrouter')
    const rows = key ? await fetchOpenRouterCatalogue(key).catch(() => []) : []
    const known = new Set(getModels().map((m) => m.id))
    return rows.map((r) => ({ ...r, inCatalogue: known.has(r.id) }))
  })

  // Renderer → main: the hosts OpenRouter routes to, for completing a name in the allowlist editor.
  // Asked when the editor opens, and like the catalogue only with a key: nothing leaves the machine
  // before the user has acted. Without a key there is no completion; a slug typed in full still works.
  ipcMain.handle('ai:openrouterProviders', async () => {
    const key = getApiKey('openrouter')
    return key ? await fetchOpenRouterProviders(key).catch(() => []) : []
  })

  // Renderer → main: add one model to the user's own models.json, or take one out again.
  //
  // Both go through the SAME loader that reads the file at startup: the file is written, then read
  // back and validated, and what the reader accepted becomes the catalogue. So the dialog can
  // never put something into memory that a restart would then refuse — the two paths cannot drift
  // because there is only one of them.
  const rewrite = (models: AiModel[]): { ok: boolean; problems: string[] } => {
    const dir = userDataDir()
    if (!dir) return { ok: false, problems: ['No user folder available.'] }
    const path = userModelsPath(dir)
    try {
      writeUserModels(path, models)
    } catch (e) {
      return { ok: false, problems: [`models.json could not be written (${(e as Error).message}).`] }
    }
    const load = loadUserModels(BUILTIN_IDS, path)
    setUserModels(load)
    // The price map is fetched for the ids that existed when it was filled; a new one would show a
    // dash until the hour was up. Drop it so the next ai:models call prices the whole catalogue.
    clearPriceCache()
    return { ok: true, problems: load.problems }
  }

  ipcMain.handle('ai:addUserModel', (_e, entry: Partial<AiModel> & { id: string }) => {
    if (getModels().some((m) => m.id === entry.id))
      return { ok: false, problems: [`"${entry.id}" is already in the list.`] }
    return rewrite([...getUserModels(), entry as AiModel])
  })

  ipcMain.handle('ai:removeUserModel', (_e, id: string) =>
    rewrite(getUserModels().filter((m) => m.id !== id))
  )

  // Renderer → main: the tool catalog (friendly names + hints) for Settings → AI-Tools.
  ipcMain.handle('ai:tools', () => toolCatalog())

  // Renderer → main: the catalogue for every picker, the plan card, the cost ledger and the Models table.
  // Answers at once and asks nobody: the direct providers' rows carry their hand-maintained list prices
  // (`pricingSource: 'list'`, as they stand TODAY by `priceOn` — the figure the transports bill with);
  // OpenRouter rows carry none, their live prices come separately (`ai:openrouterPrices`), asked only by
  // the one table that shows them. Waiting for those here held every model choice in the app.
  ipcMain.handle('ai:models', () =>
    getModels().map((m) =>
      PROVIDER_CAPS[m.provider ?? 'openrouter'].pricing === 'list'
        ? { ...m, pricing: priceOn(m) ?? null, pricingSource: 'list' }
        : { ...m, pricing: null }
    )
  )

  // Renderer → main: OpenRouter's live prices for the Models table — per model, the cheapest provider the
  // allowlist and zero-retention setting leave (fetchOpenRouterPricing in openrouterListings.ts). Only
  // with a key: without one the columns stay blank and nothing is sent. Chat rows only — the speech
  // model is billed per audio unit, and its figure in a column headed $/1M would be no token price.
  ipcMain.handle('ai:openrouterPrices', async () => {
    if (!getApiKey('openrouter')) return {}
    const ids = getModels()
      .filter((m) => (m.provider ?? 'openrouter') === 'openrouter' && m.selectable !== false)
      .map((m) => m.id)
    return fetchPricing(ids).catch(() => ({}))
  })
}
