/**
 * The app settings surface (userData/settings.json). Not an AI concern — it lived inside
 * `registerAi` only because the AI pages were the first consumers — but main needs these before a
 * window exists (the cost brake, the zero-data-retention decision, the disabled tools), so the
 * handlers live in main either way. Write-through; there is no Save button.
 */
import { ipcMain } from 'electron'

import { getSettings, seedSettings, setSettings, type AppSettings } from '../settings'
import { applySettings } from '../settingsMirror'

export function registerSettingsIpc(): void {
  // The mirrors from the store, now, rather than from the renderer later: until 2026-07-31 the
  // zero-data-retention default held until a window came up and told us, which is a race the code
  // named and lived with. A privacy decision (and the provider decision) should not depend on how
  // fast a window loads.
  applySettings(getSettings())

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    // Several settings are enforced in module state elsewhere (the OpenRouter transport's
    // zero-data-retention and throughput copies, the active provider — which takes effect
    // mid-conversation — and the session's spell checker). applySettings is the one list of those
    // mirrors; every write runs it.
    const next = setSettings(patch ?? {})
    applySettings(next)
    return next
  })
  // One-time handover of what the renderer's store held before these settings moved out of it.
  ipcMain.handle('settings:seed', (_e, legacy: Partial<AppSettings>) => {
    const next = seedSettings(legacy ?? {})
    applySettings(next)
    return next
  })
}
