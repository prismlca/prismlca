import { useState } from 'react'
import { setAS, useAppSettings } from '../../lib/appSettings'
import {
  allowlistIsDefault,
  effectiveAllowlist,
  PROVIDER_ALLOWLIST_RESET,
  type AllowlistDelta
} from '../../../../shared/providerAllowlist'
import { ProviderAllowlistEditor } from './ProviderAllowlistEditor'

/**
 * AI → Provider, under the provider cards when OpenRouter is chosen: the switch that limits OpenRouter
 * to the hosts on our allowlist (shared/providerAllowlist.ts) and the button that opens the list —
 * Reset sits in the list's editor, beside Add. Main sends the
 * list as `provider.only` with every chat request (main/ai/providers/openrouter.ts).
 */
export function ProviderAllowlist(): JSX.Element {
  const as = useAppSettings()
  const on = as.providerAllowlistOn !== false
  const delta: AllowlistDelta = {
    added: as.providerAllowlistAdded ?? [],
    removed: as.providerAllowlistRemoved ?? []
  }
  const list = effectiveAllowlist(delta)
  const [editing, setEditing] = useState(false)

  return (
    <>
      <div className="allowlist-row">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className="allowlist-switch"
          onClick={() => setAS({ providerAllowlistOn: !on })}
        >
          <span className={`slide-switch${on ? ' on' : ''}`} aria-hidden="true">
            <i />
          </span>
          <span>Only use providers from the allowlist</span>
        </button>
        <button
          type="button"
          className="btn sm"
          aria-expanded={editing}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? 'Close list' : 'Edit list'}
        </button>
      </div>
      <p className="settings-hint">
        OpenRouter serves the same model from many hosts, and they are not equally reliable: in long assistant
        runs we saw some hosts drop required fields from tool calls or cut answers short. While this is on,
        requests go only to the {list.length} providers on the list — the labs, the large clouds and
        established inference hosts. Your OpenRouter account&rsquo;s own provider settings still apply.
      </p>
      {on && !list.length ? (
        <p className="settings-hint bad">
          The list is empty, so every OpenRouter request will fail. Add a provider or switch this off.
        </p>
      ) : null}
      {editing ? (
        <ProviderAllowlistEditor
          list={list}
          delta={delta}
          onChange={(d) => setAS({ providerAllowlistAdded: d.added, providerAllowlistRemoved: d.removed })}
          canReset={!allowlistIsDefault(on, delta)}
          onReset={() => setAS({ ...PROVIDER_ALLOWLIST_RESET })}
        />
      ) : null}
    </>
  )
}
