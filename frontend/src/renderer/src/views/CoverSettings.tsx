import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'
import EscapeCloser from '../components/EscapeCloser'
import { NumberInput } from '../components/NumberInput'

/** Who carries out the studies in this project, and how the title page shows it.
 *
 * Two places need this: the Settings window, where you set it once for everything you write, and the
 * cover overlay on a report card, where you are looking at the page it affects. Both render the same
 * component rather than two forms that drift apart — the second one always ends up missing a field.
 *
 * Everything is write-through, in line with the rest of the app: no Save button, text debounced so a
 * name is one request rather than one per keystroke. */
export type Identity = {
  author: string
  organisation: string
  /** Bare base64, as stored. Empty means no mark at all — nothing stands in for it. */
  company_logo: string
  logo_height_mm: number
}

const EMPTY: Identity = { author: '', organisation: '', company_logo: '', logo_height_mm: 9.6 }

/** The height in millimetres the cover draws logos at. Only a height — see the note in the store. */
const MIN_MM = 5
const MAX_MM = 25

async function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('The file could not be read.'))
    fr.readAsDataURL(file)
  })
}

/** A logo the way it appears on the cover: on white, because that is what it will sit on there — a
 * pale wordmark that vanishes on the title page should vanish here too, while you can still fix it. */
export function LogoPreview({ src, alt }: { src: string; alt: string }): JSX.Element {
  return <img className="cover-logo-thumb" src={`data:image/png;base64,${src}`} alt={alt} />
}

export function IdentityFields({ onError }: { onError?: (message: string | null) => void }): JSX.Element {
  const [value, setValue] = useState<Identity>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const logoRef = useRef<HTMLInputElement>(null)
  // The write-through timer, so typing a name posts once at the end and not eight times, and the
  // patch it will send. Accumulated rather than replaced: filling in the name and then tabbing
  // straight into the company field used to cancel the first write and store only the second.
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef<Partial<Identity>>({})
  /** Edits per field, counted — so a write that fails puts back only what nobody has typed over since. */
  const edits = useRef<Record<string, number>>({})

  useEffect(() => {
    void api<Identity>('GET', '/api/v1/report/identity')
      .then((r) => setValue({ ...EMPTY, ...r }))
      .catch((e) => onError?.(errMsg(e)))
      .finally(() => setLoaded(true))
    // Loaded once per mount on purpose: re-fetching on every error-handler identity would fight the
    // debounce and put the server's copy back under the cursor mid-word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Unmounting (closing Settings, switching its category) inside the debounce used to drop the last
  // keystrokes of a name or company under a panel that promises to save as you type:
  // whatever is still pending goes out on the way out.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      const body = pending.current
      pending.current = {}
      if (Object.keys(body).length) void api('POST', '/api/v1/report/identity', body).catch(() => {})
    },
    []
  )

  const push = useCallback(
    (patch: Partial<Identity>, debounce = false): void => {
      setValue((v) => ({ ...v, ...patch }))
      onError?.(null)
      pending.current = { ...pending.current, ...patch }
      for (const k of Object.keys(patch)) edits.current[k] = (edits.current[k] ?? 0) + 1
      const send = (): void => {
        const body = pending.current
        pending.current = {}
        const sentAt = Object.fromEntries(Object.keys(body).map((k) => [k, edits.current[k]]))
        void api<Identity>('POST', '/api/v1/report/identity', body)
          // Only what the server did not just take from us: while the request was in flight the
          // author may have typed on, and echoing the response wholesale would undo those keystrokes.
          .then((r) => setValue({ ...EMPTY, ...r, ...pending.current }))
          .catch((e) => {
            // The field still shows what was typed; keep it queued so the next edit sends it along
            // instead of the store quietly holding the old value. A field edited
            // again since — sent or not — is left out: its newer value must not be overwritten.
            const unsent = Object.fromEntries(
              Object.entries(body).filter(([k]) => edits.current[k] === sentAt[k])
            ) as Partial<Identity>
            pending.current = { ...unsent, ...pending.current }
            onError?.(errMsg(e))
          })
      }
      clearTimeout(timer.current)
      if (debounce) timer.current = setTimeout(send, 450)
      else send()
    },
    [onError]
  )

  if (!loaded) return <p className="settings-hint">Loading…</p>

  return (
    <>
      <label className="settings-field ident-text">
        <span>Your name</span>
        <input
          value={value.author}
          placeholder="e.g. Jane Doe"
          onChange={(e) => push({ author: e.target.value }, true)}
        />
      </label>
      <label className="settings-field ident-text">
        <span>Company</span>
        <input
          value={value.organisation}
          placeholder="e.g. Doe Consulting"
          onChange={(e) => push({ organisation: e.target.value }, true)}
        />
      </label>
      <p className="settings-hint">
        Printed on the title page of every report whose study metadata leaves the author or the organisation
        empty. A study that names its own author keeps it.
      </p>
      <div className="settings-field cover-row">
        <span>Company logo</span>
        <div className="cover-controls">
          <button className="btn sm" onClick={() => logoRef.current?.click()}>
            {value.company_logo ? 'Replace' : 'Upload'}
          </button>
          {value.company_logo ? (
            <>
              <LogoPreview src={value.company_logo} alt="Company logo" />
              <button
                className="btn sm"
                title="Remove it — your logo then leaves the cover"
                onClick={() => push({ company_logo: '' })}
              >
                Remove
              </button>
            </>
          ) : (
            /* Nothing stands in for a missing mark any more, which is what removed the third state:
               a "No logo at all" switch existed only because an empty field meant "use the PrismLCA mark". */
            <span className="faint">— no company logo is printed</span>
          )}
          <input
            ref={logoRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) {
                void readImage(f)
                  .then((data) => push({ company_logo: data }))
                  .catch((err) => onError?.(errMsg(err)))
              }
            }}
          />
        </div>
      </div>
      {/* Only the company side is promised empty: a client logo set on a report prints on its own (the
          template draws the two independently), and both share the one height below. */}
      <p className="settings-hint">
        Your logo goes on the title page of every report. Without one, your side of the cover stays empty —
        PrismLCA does not put its own there; a client&rsquo;s logo, set per report, still prints. The height
        below applies to both logos.
      </p>
      <label className="settings-field">
        <span>Logo height</span>
        <span className="cover-controls">
          <NumberInput
            min={MIN_MM}
            max={MAX_MM}
            step={0.2}
            value={value.logo_height_mm}
            style={{ width: '5.5em' }}
            onValue={(raw) => {
              const n = Number(raw)
              if (!Number.isNaN(n)) push({ logo_height_mm: Math.min(MAX_MM, Math.max(MIN_MM, n)) }, true)
            }}
          />
          <span className="faint">mm — the width follows, so a logo is never squashed</span>
        </span>
      </label>
    </>
  )
}

type CoverOverlayProps = {
  /** `/api/v1/report/{id}` — the report this cover belongs to. */
  base: string
  report: { cover_image?: string; client_logo?: string; template: string }
  templates: { name: string; cover_image?: boolean; client_logo?: boolean }[]
  /** The shipped picture, base64, for the thumbnail of a report that stores only the word "default". */
  placeholder: string | null
  onClose: () => void
  onChanged: () => void
}

/** Everything the title page shows, in one window: the picture, the two logos and who wrote the study.
 *
 * It hangs off the pinned "Title page" row rather than living on the card, because the card is the
 * chapter list and a cover is not a chapter — but it is the first page, so that is where you look
 * for it. */
export function CoverOverlay({
  base,
  report,
  templates,
  placeholder,
  onClose,
  onChanged
}: CoverOverlayProps): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const coverRef = useRef<HTMLInputElement>(null)
  const clientRef = useRef<HTMLInputElement>(null)

  const write = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      setError(null)
      try {
        await api('POST', base, patch)
        onChanged()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [base, onChanged]
  )

  const upload = useCallback(
    (file: File, field: 'cover_image' | 'client_logo'): void => {
      void readImage(file)
        .then((data) => write({ [field]: data }))
        .catch((e) => setError(errMsg(e)))
    },
    [write]
  )

  // Read from the template list rather than hardcoded ids, so a template that starts or stops placing
  // either of these needs no change here.
  const selected = templates.find((t) => t.name === report.template)
  const usesCover = selected?.cover_image !== false
  const usesClientLogo = selected?.client_logo !== false

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet cover-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Title page</h3>
            <p>The picture and the logos on this report&rsquo;s cover, and who wrote the study.</p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {/* Write-through like the rest of the app, so the X is the only way out it needs. */}
        <div className="sheet-body">
          <div className="mi-sechead">
            <span className="mi-swatch" aria-hidden="true" />
            <h4>This report</h4>
          </div>
          <div className="settings-field cover-row">
            <span>Cover image</span>
            <div className="cover-controls">
              <button
                className="btn sm"
                title="A PNG or JPEG for the title page. Without one that cover uses its own layout — it is not left with a gap."
                onClick={() => coverRef.current?.click()}
              >
                {report.cover_image ? 'Replace' : 'Upload'}
              </button>
              {report.cover_image ? (
                <>
                  <img
                    className="cover-thumb"
                    // A report using the shipped picture stores the word "default", not the bytes, so the
                    // thumbnail comes from the app rather than from the report.
                    src={`data:image/png;base64,${report.cover_image === 'default' ? (placeholder ?? '') : report.cover_image}`}
                    alt="Cover image"
                    title={
                      report.cover_image === 'default'
                        ? 'The picture shipped with the app'
                        : 'On the title page'
                    }
                  />
                  <button className="btn sm" onClick={() => void write({ cover_image: '' })}>
                    Remove
                  </button>
                </>
              ) : (
                <button
                  className="btn sm"
                  title="Put the picture that ships with PrismLCA back on the cover"
                  onClick={() => void write({ cover_image: 'default' })}
                >
                  Placeholder
                </button>
              )}
              <input
                ref={coverRef}
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = '' // so picking the same file twice fires again
                  if (f) upload(f, 'cover_image')
                }}
              />
            </div>
          </div>
          {!usesCover ? (
            <p className="settings-hint">
              The selected theme brings its own cover — switch to one that places your picture to see it.
            </p>
          ) : null}
          <div className="settings-field cover-row">
            <span>Client logo</span>
            <div className="cover-controls">
              <button
                className="btn sm"
                title="The commissioning party's mark, opposite your own on the title page"
                onClick={() => clientRef.current?.click()}
              >
                {report.client_logo ? 'Replace' : 'Upload'}
              </button>
              {report.client_logo ? (
                <>
                  <LogoPreview src={report.client_logo} alt="Client logo" />
                  <button className="btn sm" onClick={() => void write({ client_logo: '' })}>
                    Remove
                  </button>
                </>
              ) : (
                <span className="faint">— nothing is drawn there</span>
              )}
              {!usesClientLogo ? (
                <span className="faint" title="Switch to a theme that draws a second mark to use this">
                  — not used by this theme
                </span>
              ) : null}
              <input
                ref={clientRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) upload(f, 'client_logo')
                }}
              />
            </div>
          </div>
          {/* This report's own picture and logo above; below, what every report in the project shares. */}
          <div className="mi-sechead">
            <span className="mi-swatch" aria-hidden="true" />
            <h4>Used by every report</h4>
          </div>
          <IdentityFields onError={setError} />
          {error ? <p className="cover-error">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}
