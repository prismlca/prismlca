import { useEffect, useMemo, useState } from 'react'
import UnitCombo from '../../components/UnitCombo'
import { KEY_CHANGED_EVENT, orProviders, type OrProviderRow } from '../../lib/ai'
import {
  addToAllowlist,
  normaliseSlug,
  PROVIDER_NAMES,
  removeFromAllowlist,
  type AllowlistDelta
} from '../../../../shared/providerAllowlist'

/**
 * The allowlist itself, opened by "Edit list": one chip per host with its remove button, and a field
 * that adds one. Every change writes through — there is no Save.
 *
 * Completion comes from OpenRouter's listing of its hosts, asked for when the editor opens — only with
 * an OpenRouter key, like the prices on the Models page, and kept an hour in main. Without a key there
 * is no completion and nothing is sent; a slug typed in full is still taken. The chips are named from
 * our own names for the default hosts first, then from the listing where it is loaded.
 */
export function ProviderAllowlistEditor({
  list,
  delta,
  onChange,
  canReset,
  onReset
}: {
  list: string[]
  delta: AllowlistDelta
  onChange: (next: AllowlistDelta) => void
  /** Anything to reset — the switch or the list differs from our default. */
  canReset: boolean
  /** Back to our default: the switch on, the list without the user's changes. */
  onReset: () => void
}): JSX.Element {
  const [rows, setRows] = useState<OrProviderRow[]>([])
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)

  // Asked when the editor opens, and again whenever a key is entered or removed on this page (the key
  // block sits right below): with a key the suggestions appear, without one they go. Only the newest
  // answer counts.
  useEffect(() => {
    let latest = 0
    let live = true
    const load = (): void => {
      const mine = ++latest
      void orProviders()
        .then((r) => {
          if (live && mine === latest) setRows(r)
        })
        .catch(() => undefined)
    }
    load()
    window.addEventListener(KEY_CHANGED_EVENT, load)
    return () => {
      live = false
      window.removeEventListener(KEY_CHANGED_EVENT, load)
    }
  }, [])

  const bySlug = useMemo(() => new Map(rows.map((r) => [r.slug, r])), [rows])
  const byName = useMemo(() => new Map(rows.map((r) => [r.name.toLowerCase(), r.slug])), [rows])
  const nameOf = (slug: string): string => PROVIDER_NAMES[slug] ?? bySlug.get(slug)?.name ?? slug
  // Offered for completion: every host not on the list yet.
  const offered = useMemo(() => rows.filter((r) => !list.includes(r.slug)).map((r) => r.slug), [rows, list])

  const add = (raw: string): void => {
    // A name typed in full ("Google AI Studio") means its slug, the same as picking it from the list.
    const slug = byName.get(raw.trim().toLowerCase()) ?? normaliseSlug(raw)
    if (!slug) {
      setNote(raw.trim() ? { text: `“${raw.trim()}” is not a provider slug.`, bad: true } : null)
      return
    }
    // Only with OpenRouter's listing at hand can a typo be told from a host it has just added.
    setNote(
      rows.length && !bySlug.has(slug.split('/')[0])
        ? {
            text: `OpenRouter lists no provider “${slug}”. It was added as typed — check the spelling.`,
            bad: false
          }
        : null
    )
    setTyped('')
    onChange(addToAllowlist(delta, slug))
  }

  return (
    <div className="allowlist-editor">
      {list.length ? (
        <ul className="allowlist-items" aria-label="Allowed providers">
          {list.map((slug) => (
            <li key={slug} className="allowlist-item" title={slug}>
              <span>{nameOf(slug)}</span>
              <button
                type="button"
                className="allowlist-remove"
                aria-label={`Remove ${nameOf(slug)}`}
                title="Remove from the list"
                onClick={() => onChange(removeFromAllowlist(delta, slug))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-hint">No provider on the list.</p>
      )}
      <div className="allowlist-add">
        <UnitCombo
          value={typed}
          units={offered}
          onChange={(v) => {
            setTyped(v)
            setNote(null)
          }}
          onPick={add}
          label={(slug) => bySlug.get(slug)?.name ?? slug}
          describe={(slug) => {
            const hq = bySlug.get(slug)?.headquarters
            return hq ? `${slug}, ${hq}` : slug
          }}
          ariaLabel="Add a provider"
          placeholder={rows.length ? 'Add a provider…' : 'Add a provider by its slug, e.g. groq'}
        />
        <button type="button" className="btn sm" disabled={!typed.trim()} onClick={() => add(typed)}>
          Add
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={!canReset}
          onClick={() => {
            setNote(null)
            onReset()
          }}
        >
          Reset defaults
        </button>
      </div>
      {note ? <p className={`settings-hint${note.bad ? ' bad' : ' warn'}`}>{note.text}</p> : null}
      {rows.length ? null : (
        <p className="settings-hint">
          Suggestions come from OpenRouter once an OpenRouter key is set. Without one, nothing is asked, and a
          provider is added by its slug as OpenRouter writes it.
        </p>
      )}
    </div>
  )
}
