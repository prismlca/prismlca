import { useCallback, useRef, useState } from 'react'
import { api } from '../lib/api'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import ThemePreview, { forgetThemePreview } from './ThemePreview'
import type { PaletteColors } from './PalettePicker'
import { deliverBlob } from '../lib/download'
import { errMsg } from '../lib/errors'

export type Theme = {
  name: string
  label?: string
  builtin?: boolean
  cover_image?: boolean
  client_logo?: boolean
}

type Props = {
  themes: Theme[]
  /** The theme the open report uses: its card carries the ring and is not offered again. */
  selected: string
  /** Point the report at another theme. */
  onSelect: (name: string) => void
  /** Re-read the list after an upload or a delete. */
  onChanged: () => void | Promise<void>
  /** The report's colour set: the covers are shown in the colours the document will be typeset in. */
  palette?: string
  /** The report's hand-picked three, so a tile shows what the document will look like. */
  colors?: PaletteColors
}

/**
 * The report themes, as a gallery inside the Appearance group.
 *
 * It used to be a dropdown plus a **Themes** window, for a reason that has since expired: the report card
 * was mostly a chapter list, and uploading, downloading and deleting were three more controls than one row
 * could carry. The accordion gave Appearance a panel of its own, with only one group open at a time — so
 * there is room, and a window you have to open and close again to change a look is a window in the way.
 *
 * A gallery rather than a list, because choosing a theme *is* choosing a picture: the label is at best a
 * hint, and the covers were already being rendered for the dropdown's hover preview. The card is the
 * control — clicking it points the report at that theme — which is the same gesture as picking a model on
 * the Overview page. Download and Delete appear on the card the pointer is on, the way a chapter row shows
 * its actions, so eleven themes do not put thirty-three buttons on the panel.
 *
 * The five shipped themes cannot be replaced or deleted (the backend refuses it): every report that points
 * at one has to keep resolving, and a project that could overwrite "default" would lose the fallback every
 * other report relies on.
 */
export default function ThemeGallery({
  themes,
  selected,
  onSelect,
  onChanged,
  palette,
  colors
}: Props): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Deleting a theme is not undoable and it moves every report that used it, so it asks first.
  const [confirming, setConfirming] = useState<ConfirmSpec | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = useCallback(
    async (file: File): Promise<void> => {
      setError(null)
      setNote(null)
      setBusy(true)
      try {
        const source = await file.text()
        const name = file.name.replace(/\.typ$/i, '') || 'custom'
        // Validated in the backend by compiling the fixture against it, so a broken theme is refused here
        // with the compiler's own message instead of breaking a report the day someone picks it.
        await api('POST', '/api/v1/report/templates', { name, source })
        // An upload under an existing name replaces its cover, so the old picture must not be reused.
        forgetThemePreview(name)
        await onChanged()
        setNote(`“${name}” added.`)
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
      }
    },
    [onChanged]
  )

  const download = useCallback(async (name: string, label: string): Promise<void> => {
    setError(null)
    setNote(null)
    try {
      // One endpoint for both kinds: a theme the project uploaded has to be downloadable too, or it
      // cannot be edited again once the file on disk is gone.
      const r = await api<{ source: string }>(
        'GET',
        `/api/v1/report/templates/${encodeURIComponent(name)}/source`
      )
      deliverBlob(new Blob([r.source], { type: 'text/plain' }), `${name}.typ`)
      setNote(`“${label}” downloaded as ${name}.typ.`)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const remove = useCallback(
    async (name: string): Promise<void> => {
      setError(null)
      setNote(null)
      setBusy(true)
      try {
        await api('POST', `/api/v1/report/templates/${encodeURIComponent(name)}/delete`, {})
        // Reports that pointed at it are moved to the default by the backend, so the card has to re-read
        // itself as well — otherwise it would keep showing a theme that no longer exists.
        await onChanged()
        setNote(`“${name}” removed. Reports that used it fall back to the standard theme.`)
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
      }
    },
    [onChanged]
  )

  return (
    <div className="thg">
      <div className="thg-grid">
        {themes.map((t) => {
          const label = t.label ?? t.name
          const on = t.name === selected
          return (
            <div className={`thg-card${on ? ' on' : ''}`} key={t.name}>
              {/* The card itself is the picker: a button around the picture, so the whole tile is the
                  target and the keyboard reaches it by Tab like any other control. */}
              <button
                className="thg-pick"
                aria-pressed={on}
                disabled={busy || on}
                title={on ? `“${label}” is the theme of this report` : `Use “${label}” for this report`}
                onClick={() => onSelect(t.name)}
              >
                <ThemePreview name={t.name} palette={palette} colors={colors} variant="tile" />
                {/* On the picture, at its foot, rather than in the row under it: the ring
                    already marks the tile, so the word belongs on the tile too — and the meta row is then
                    the same height on every card. */}
                {on ? <span className="thg-badge on thg-inuse">in use</span> : null}
              </button>
              <div className="thg-meta">
                <span className="thg-name" title={label}>
                  {label}
                </span>
                {/* The uploaded ones are marked, not the shipped ones: a mark every card carries marks
                    nothing. That a shipped theme cannot be deleted is already said by its missing ✕, and
                    that a theme draws its own cover is said beside the cover-picture upload, where it
                    matters. */}
                {t.builtin ? null : <span className="thg-badge">yours</span>}
              </div>
              {/* On the card the pointer is on: twelve themes would otherwise carry thirty-six buttons. */}
              <div className="thg-acts">
                <button
                  className="thg-act"
                  title="Download as the starting point for a theme of your own"
                  aria-label={`Download ${label}`}
                  onClick={() => void download(t.name, label)}
                >
                  ↓
                </button>
                {/* Shipped themes have no Delete: the backend refuses it, and a button that always fails
                    is worse than no button. */}
                {t.builtin ? null : (
                  <button
                    className="thg-act danger"
                    disabled={busy}
                    title="Delete this theme"
                    aria-label={`Delete ${label}`}
                    onClick={() =>
                      setConfirming({
                        title: 'Delete theme',
                        message:
                          `Delete the theme “${t.name}”? This cannot be undone, and every report using it ` +
                          `falls back to the standard theme.`,
                        confirmLabel: 'Delete',
                        danger: true,
                        onConfirm: () => void remove(t.name)
                      })
                    }
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <button className="add-flow-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
        + Upload a theme…
      </button>
      {/* `Typst` set as what it is — the name of the language the file is written in, like `.typ` beside it.
          Spelled out rather than called "a layout", because knowing the word is what lets someone
          look it up and actually write one. */}
      <p className="settings-hint">
        The whole look — cover, headings, tables, figures — as a <code>Typst</code> file. Download one, edit
        it, upload it back — that file is the contract in full, and it compiles before you start. A theme that
        does not compile is refused with the compiler&rsquo;s message; one that leaves out a piece of the
        contract is told which pieces. A theme decides your layout, so prefer sources you trust.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".typ,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // so picking the same file twice fires again
          if (f) void upload(f)
        }}
      />
      {error ? <p className="cover-error">{error}</p> : null}
      {note ? <p className="settings-hint">{note}</p> : null}
      {confirming ? <ConfirmDialog spec={confirming} onClose={() => setConfirming(null)} /> : null}
    </div>
  )
}
