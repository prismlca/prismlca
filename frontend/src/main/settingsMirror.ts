/**
 * The ONE list of module-state mirrors that settings.json feeds: the OpenRouter transport's
 * zero-data-retention, throughput and allowlist copies, the active provider, and the session's
 * spell-checker languages. Every path that changes settings — startup, `settings:set`,
 * `settings:seed` — must run the SAME list. It used to be written out at each site, and
 * `settings:seed` applied only two of the four: a user upgrading with a stored `minThroughput` or
 * dictionary choice lost both until the next settings write.
 */
import { setMinThroughput, setProviderAllowlist, setZeroDataRetention } from './ai/providers/openrouter'
import { setActiveProvider } from './ai/providers/state'
import type { AppSettings } from './settings'
import { effectiveAllowlist } from '../shared/providerAllowlist'
import { applySpellcheckLanguages } from './spellcheck'

export function applySettings(next: AppSettings): void {
  setZeroDataRetention(next.zeroDataRetention, {
    anthropic: next.zdrExceptAnthropic,
    openai: next.zdrExceptOpenai,
    google: next.zdrExceptGoogle
  })
  setMinThroughput(next.minThroughput)
  setProviderAllowlist(
    next.providerAllowlistOn
      ? effectiveAllowlist({ added: next.providerAllowlistAdded, removed: next.providerAllowlistRemoved })
      : null
  )
  setActiveProvider(next.provider)
  // Before app.whenReady() there is no session to configure; applySpellcheckLanguages skips that
  // case itself, and initSpellcheck() applies the stored choice once the session exists.
  applySpellcheckLanguages(next.spellcheckLanguages)
}
