/**
 * What every AI IPC module needs handed in: the backend transport and the window to stream events
 * to. One deps shape instead of five — the registrars stay constructor-injected like
 * `registerCore(deps)`, so a test can build the whole surface without Electron wiring.
 */
import type { BrowserWindow } from 'electron'

import { modelBelongsTo } from '../ai/models'
import { getActiveProvider } from '../ai/providers/state'

export interface AiIpcDeps {
  apiRequest: (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ) => Promise<{ status: number; body: unknown }>
  getWindow: () => BrowserWindow | null
  /** MCP activity (session opened, call finished) → the idle quit of a bridge-launched app (index.ts). */
  onMcpActivity?: () => void
  /** An MCP call in flight (+1) / finished (−1): the idle clock pauses meanwhile. */
  onMcpBusy?: (delta: 1 | -1) => void
}

/** Every live run, keyed by chat id — or by `report:ai:<uuid>` for a report writer's lane. Shared
 *  between the chat module (send/cancel/isRunning own the map) and the report module (each call
 *  registers its lane here so one Stop pulls everything). Created per `registerAi` call, never
 *  module state. */
export type RunControllers = Map<string, AbortController>

/** A stored model choice that belongs to the INACTIVE provider reads as "not set" — the role's
 *  provider default takes over (subagent.ts/reportWriter.ts resolve it), instead of an id
 *  travelling to an API that answers 404 for it. The choice itself stays stored for the switch
 *  back. OpenRouter keeps today's permissive reading: any non-empty id passes through. */
export const modelForActive = (id: string | undefined): string => {
  if (!id) return ''
  const p = getActiveProvider()
  if (p === 'openrouter') {
    // Permissive, except for an id the catalogue knows as a DIRECT OpenAI model and not as an
    // OpenRouter one: that is a choice made under the other provider, and it travelled to OpenRouter
    // as-is while the UI showed the default.
    return modelBelongsTo(id, 'openai') && !modelBelongsTo(id, 'openrouter') ? '' : id
  }
  return modelBelongsTo(id, p) ? id : ''
}
