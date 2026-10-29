/**
 * The provider keys: stored by the OS via safeStorage, pushed to the backend, never handed to the
 * renderer. Everything Settings may learn about a key is its status — that there is one, a masked
 * hint, whether the environment overrides it, and which OS store holds it.
 */
import { ipcMain } from 'electron'

import { getApiKey, resetApiKey } from '../ai/client'
import {
  clearSecret,
  resolve as resolveKey,
  setSecret,
  status as secretStatus,
  type Provider
} from '../secrets'
import type { AiIpcDeps } from './shared'

export function registerKeyIpc(deps: AiIpcDeps): void {
  // Renderer → main: is a key configured for the ACTIVE provider? (the key never leaves main).
  ipcMain.handle('ai:hasKey', () => !!getApiKey())

  // Everything below takes a provider argument, defaulting to OpenRouter for older callers. The
  // guard matters because the value crosses the IPC boundary: anything unknown becomes the default
  // rather than a new file entry in secrets.json.
  const asProvider = (p: unknown): Provider => (p === 'openai' ? 'openai' : 'openrouter')

  // Renderer → main: everything Settings may know about the stored key — that there is one, a masked
  // hint, whether the environment is overriding it, and which OS store holds it. Never the key.
  ipcMain.handle('ai:keyStatus', (_e, provider?: string) => secretStatus(asProvider(provider)))

  /** Store or clear a key, then make both consumers use it at once: the chat client here in main,
   *  and the backend, which needs the same keys for API embeddings (RAG). Without the push the backend
   *  would only see it at its next start, and "I entered a key and search still says no key" is the
   *  bug that follows. Note the backend keeps BOTH provider keys (config.py) — pushing one never
   *  clears the other, and switching the active provider clears neither. Its embedding-backend
   *  choice stays env-driven (PRISM_EMBEDDING_BACKEND); mind that switching an API embedding backend
   *  between openrouter and openai invalidates a built search index (the index records the provider
   *  name), even though text-embedding-3-large produces identical vectors on both. */
  /** What main itself will use for this provider after the change — the environment outranks the
   *  store (secrets.resolve). Pushing the typed value instead sent the backend a key the chat did not
   *  use, and clearing pushed '' while the environment still held one. */
  const pushEffective = async (provider: Provider): Promise<void> => {
    const key = resolveKey(provider).key ?? ''
    // Best-effort: the backend may still be starting. It also reads the keys from its environment at
    // spawn, so a failure here only costs the no-restart convenience.
    await deps.apiRequest('POST', '/api/v1/system/provider-key', { provider, key }).catch(() => undefined)
  }
  const applyKey = async (provider: Provider, key: string): Promise<void> => {
    setSecret(provider, key)
    resetApiKey()
    await pushEffective(provider)
  }

  ipcMain.handle('ai:setKey', async (_e, key: string, provider?: string) => {
    const p = asProvider(provider)
    try {
      await applyKey(p, typeof key === 'string' ? key : '')
      return { ok: true, status: secretStatus(p) }
    } catch (err) {
      // The one expected failure: a platform with no credential store. Its message is the advice.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ai:clearKey', async (_e, provider?: string) => {
    const p = asProvider(provider)
    clearSecret(p)
    resetApiKey()
    await pushEffective(p)
    return { ok: true, status: secretStatus(p) }
  })
}
