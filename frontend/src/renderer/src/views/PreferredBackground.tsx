/**
 * Settings → Modelling: which background database the assistant takes when several are released
 * to a chat and more than one has a fitting dataset — or whether it decides itself and says why.
 *
 * An app setting (main owns it), because it has to reach the agent: the system prompt states the
 * rule and `search_background` marks the preferred database's hits and lists them first. It applies
 * only while that database is switched on in the chat's "+" menu; switched off, the assistant is told
 * the preference does not apply rather than left to guess.
 */
import { useEffect, useState } from 'react'
import { api, type DatabaseInfo } from '../lib/api'
import { setAS, useAppSettings } from '../lib/appSettings'

export default function PreferredBackgroundField(): JSX.Element {
  const preferred = (useAppSettings().preferredBackground as string | undefined) ?? ''
  const [backgrounds, setBackgrounds] = useState<string[]>([])
  useEffect(() => {
    api<DatabaseInfo[]>('GET', '/api/v1/databases')
      .then((dbs) => setBackgrounds(dbs.filter((d) => d.kind === 'background').map((d) => d.name)))
      .catch(() => setBackgrounds([]))
  }, [])
  // A stored preference for a database that is no longer installed stays selectable, so the user
  // sees what is set instead of the field silently showing "assistant decides".
  const options = preferred && !backgrounds.includes(preferred) ? [...backgrounds, preferred] : backgrounds

  return (
    <>
      <h4>Background databases</h4>
      <label className="settings-field">
        <span>When several are released to a chat</span>
        <select
          aria-label="Preferred background database"
          value={preferred}
          onChange={(e) => setAS({ preferredBackground: e.target.value })}
        >
          <option value="">Let the assistant decide — and say why</option>
          {options.map((name) => (
            <option key={name} value={name}>
              Prefer {name}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint">
        Matters only when a chat has more than one background database switched on (ecoinvent and BAFU, say)
        and both hold a fitting dataset. The assistant then uses the preferred one and goes elsewhere only
        when it has no fit, saying so in the exchange comment; without a preference it picks by geography,
        reference year and system model and names its choice. Does not apply in a chat where the preferred
        database is switched off.
      </p>
    </>
  )
}
