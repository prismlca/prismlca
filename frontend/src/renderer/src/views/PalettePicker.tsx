import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'
import { PlusIcon } from '../components/icons'
import { hexInput } from '../lib/reportColors'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import NewPaletteForm from './NewPaletteForm'

/** One colour set. `builtin` is false for the sets a user added themselves — the only ones with a Delete. */
export type Palette = { id: string; label: string; hint: string; swatches: string[]; builtin?: boolean }

/** Accent, deep tone and paper picked by hand on one report. An absent or empty field means the set's own. */
export type PaletteColors = { accent?: string; deep?: string; paper?: string }

/** The three fields under the sets are a deployment decision, not a preference: the backend says whether
 *  they exist at all (`PRISM_REPORT_CUSTOM_COLORS`) and nothing in the UI can turn them on. */
let CUSTOM_OK = true

/** The catalogue is read once per session and again only when a set of your own is added or deleted — the
 *  shipped sets are fixed per version, and the own ones change only through this panel. */
let CACHE: Palette[] | null = null
let PENDING: Promise<Palette[]> | null = null
/** Every mounted `usePalettes`: the Appearance head names the set while the group is shut, so a set added in
 *  the body has to reach it too. */
const LISTENERS = new Set<(list: Palette[]) => void>()

function palettes(): Promise<Palette[]> {
  if (CACHE) return Promise.resolve(CACHE)
  if (PENDING) return PENDING
  PENDING = api<{ palettes: Palette[]; custom_colors?: boolean }>('GET', '/api/v1/report/palettes')
    .then((r) => {
      CACHE = r.palettes
      CUSTOM_OK = r.custom_colors !== false
      PENDING = null
      return r.palettes
    })
    .catch((e) => {
      PENDING = null
      throw e
    })
  return PENDING
}

/** Read the catalogue again and hand it to every mounted picker — after a set of your own came or went. */
export async function reloadPalettes(): Promise<Palette[]> {
  CACHE = null
  const list = await palettes()
  LISTENERS.forEach((l) => l(list))
  return list
}

/** The catalogue, loaded once. Also used by the panel's head, which names the set while the group is shut. */
export function usePalettes(): { list: Palette[] | null; error: string | null } {
  const [list, setList] = useState<Palette[] | null>(CACHE)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    LISTENERS.add(setList)
    if (!CACHE)
      palettes()
        .then(setList)
        .catch((e) => setError(errMsg(e)))
    return () => {
      LISTENERS.delete(setList)
    }
  }, [])
  return { list, error }
}

/**
 * The three colours of a set, for whoever draws with them: the report figures are drawn in the renderer,
 * so they need the same accent, deep tone and paper the document is typeset in. Resolves from the cached
 * catalogue, fetching it once if the picker has not been opened yet, and falls back to the default set —
 * a figure must never fail to draw because a catalogue request did.
 */
export async function paletteColors(
  id: string,
  /** The report's own three, which win over the set's — the figures have to agree with the page. */
  picked?: PaletteColors
): Promise<{ accent: string; deep: string; paper: string }> {
  const own = (base: { accent: string; deep: string; paper: string }): typeof base => ({
    accent: picked?.accent || base.accent,
    deep: picked?.deep || base.deep,
    paper: picked?.paper || base.paper
  })
  try {
    const list = await palettes()
    const p = list.find((x) => x.id === id) ?? list[0]
    const [accent, deep, paper] = p?.swatches ?? []
    if (accent && deep && paper) return own({ accent, deep, paper })
  } catch {
    /* fall through to the default */
  }
  return own({ accent: '#93c120', deep: '#2f4e66', paper: '#f8f9fa' })
}

/** The three, as the theme-preview endpoint takes them: `accent,deep,paper`, blanks for "the set's own".
 *  Empty when nothing is picked, so the URL — and with it the backend's cache key — stays as it was. */
export function colorsParam(picked?: PaletteColors): string {
  const v = [picked?.accent ?? '', picked?.deep ?? '', picked?.paper ?? '']
  return v.some(Boolean) ? v.join(',') : ''
}

/** Which set a report is actually rendered in — its own, or the first one when it names none or one that is
 *  gone. The same fallback the backend applies, so the panel never disagrees with the document. */
export function resolvePalette(list: Palette[] | null, selected: string): Palette | null {
  if (!list?.length) return null
  return list.find((p) => p.id === selected) ?? list[0]
}

/**
 * The document's colour set, as a row of swatch chips — with its own head, whose + adds a set of your own.
 *
 * Beside the theme gallery rather than inside it, because they answer two different questions: a theme
 * decides the *layout* — where the cover picture sits, how a heading is set, what a table looks like — and a
 * palette decides the *colour*. Both used to be one choice, baked into each theme's own file, so "the same
 * document but not in green" meant editing Typst. Now every theme imports the set the report names, and one
 * click repaints all of them.
 *
 * Three stripes per chip: the accent, the deep tone and the paper of the cover. Those are the colours a
 * reader sees as the document's own; the neutrals belong to the set too, but choosing between two greys is
 * not choosing. The gallery above re-renders its covers in the set that is picked, which is the real preview
 * — the chip only says which one you are looking at.
 *
 * Under the chips, one switch for the commonest exception to a set: a page of plain white. It writes the
 * report's own paper colour — the same value the hex fields edit — so it reaches the document, the gallery
 * and the figures by the road every hand-picked colour already takes, and outlives a change of set.
 *
 * Sets of your own come after the shipped ones and carry a Delete; a new one is picked for the report as soon
 * as it is added, which is what someone who just made one wants to see.
 */
export default function PalettePicker({
  selected,
  onSelect,
  colors,
  onColors
}: {
  /** The report's set. Empty or unknown shows the default as chosen, which is what the backend renders. */
  selected: string
  onSelect: (id: string) => void
  /** The three the report overrides by hand, if any. */
  colors?: PaletteColors
  /** Write them back. `{}` clears them and the set applies again. */
  onColors?: (next: PaletteColors) => void
}): JSX.Element | null {
  const { list, error } = usePalettes()
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState<ConfirmSpec | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const on = resolvePalette(list, selected)?.id
  const set = resolvePalette(list, selected)

  const remove = async (p: Palette): Promise<void> => {
    setFailed(null)
    try {
      await api('POST', `/api/v1/report/palettes/${encodeURIComponent(p.id)}/delete`)
      await reloadPalettes()
    } catch (e) {
      setFailed(errMsg(e))
    }
  }

  return (
    <div className="pal">
      {/* The head is the picker's own, so the + sits beside the word it adds to on every page that has one. */}
      <div className="pal-head">
        <span className="sub-label">Colours</span>
        {list ? (
          <button
            className={`pal-add${adding ? ' on' : ''}`}
            title="New colour set"
            aria-label="New colour set"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            <PlusIcon />
          </button>
        ) : null}
      </div>
      {error ? <p className="cover-error">{error}</p> : null}
      {adding ? (
        <NewPaletteForm
          start={[
            set?.swatches[0] ?? '#93c120',
            set?.swatches[1] ?? '#2f4e66',
            set?.swatches[2] ?? '#f8f9fa'
          ]}
          onCancel={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false)
            void reloadPalettes().then(() => onSelect(p.id))
          }}
        />
      ) : null}
      {list ? (
        <div className="pal-grid">
          {list.map((p) => (
            <div className="pal-cell" key={p.id}>
              <button
                className={`pal-chip${p.id === on ? ' on' : ''}`}
                aria-pressed={p.id === on}
                title={p.hint}
                onClick={() => onSelect(p.id)}
              >
                <span className="pal-sw" aria-hidden="true">
                  {p.swatches.map((c, i) => (
                    <i key={i} style={{ background: c }} />
                  ))}
                </span>
                <span className="pal-name">{p.label}</span>
              </button>
              {/* Shipped sets have no Delete: the backend refuses it, and a button that always fails is worse
                  than no button. */}
              {p.builtin === false ? (
                <button
                  className="pal-del"
                  title="Delete this colour set"
                  aria-label={`Delete ${p.label}`}
                  onClick={() =>
                    setConfirming({
                      title: 'Delete colour set',
                      message:
                        `Delete the colour set “${p.label}”? This cannot be undone, and every report using it ` +
                        `falls back to the PrismLCA set.`,
                      confirmLabel: 'Delete',
                      danger: true,
                      onConfirm: () => void remove(p)
                    })
                  }
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {failed ? <p className="cover-error">{failed}</p> : null}
      {list && onColors ? (
        <label
          className="pal-white"
          title="Replaces the set's paper colour with pure white, whichever set is chosen. Themes with a dark page keep theirs."
        >
          <input
            type="checkbox"
            checked={hexInput(colors?.paper ?? '') === WHITE}
            onChange={(e) => onColors({ ...(colors ?? {}), paper: e.target.checked ? WHITE : undefined })}
          />
          <span>White page background</span>
        </label>
      ) : null}
      {list && CUSTOM_OK && onColors ? (
        <HexFields set={set} colors={colors ?? {}} onColors={onColors} />
      ) : null}
      {confirming ? <ConfirmDialog spec={confirming} onClose={() => setConfirming(null)} /> : null}
    </div>
  )
}

/** Pure white: what "a white page" means, not the near-white of a set's paper. */
const WHITE = '#ffffff'

/** The three fields under the sets: try an accent, a deep tone and a paper of your own on this one report.
 *
 * Three, and exactly the three the chips show — they are what a reader sees as the document's colour. The
 * neutrals stay the set's: they are what keeps a page readable, and hand-picking a grey is how a report ends
 * up with grey-on-grey rules. A field left empty means "the set's own", which is also what makes clearing all
 * three the way back — there is no fourth state to explain.
 *
 * Committed on blur or Enter, not per keystroke: every write repaints six theme tiles and re-typesets the
 * preview, and "#2f" is not a colour. The field shows the set's value as its placeholder, so an empty field
 * says what it will use.
 */
function HexFields({
  set,
  colors,
  onColors
}: {
  set: Palette | null
  colors: PaletteColors
  onColors: (next: PaletteColors) => void
}): JSX.Element {
  const FIELDS: { key: keyof PaletteColors; label: string; swatch: number }[] = [
    { key: 'accent', label: 'Accent', swatch: 0 },
    { key: 'deep', label: 'Deep', swatch: 1 },
    { key: 'paper', label: 'Paper', swatch: 2 }
  ]
  const any = FIELDS.some((f) => colors[f.key])
  const commit = (key: keyof PaletteColors, raw: string): void => {
    const v = raw.trim().toLowerCase()
    // A bare "2f4e66" is what a colour picker hands you; the # is ours to add.
    const hex = v && !v.startsWith('#') ? `#${v}` : v
    if ((colors[key] ?? '') === hex) return
    onColors({ ...colors, [key]: hex || undefined })
  }
  return (
    <div className="pal-own">
      <div className="pal-own-head">
        <span className="sub-label">Your own</span>
        {any ? (
          <button className="linklike" onClick={() => onColors({})}>
            Back to the set
          </button>
        ) : null}
      </div>
      <div className="pal-own-row">
        {FIELDS.map((f) => (
          <label className="pal-own-f" key={f.key}>
            <span>{f.label}</span>
            <span className="pal-own-in">
              <i style={{ background: colors[f.key] || set?.swatches[f.swatch] }} aria-hidden="true" />
              <input
                defaultValue={colors[f.key] ?? ''}
                placeholder={set?.swatches[f.swatch] ?? '#rrggbb'}
                spellCheck={false}
                key={`${f.key}:${colors[f.key] ?? ''}`}
                onBlur={(e) => commit(f.key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') {
                    e.stopPropagation() // abandons this colour field, not the dialog
                    ;(e.target as HTMLInputElement).value = colors[f.key] ?? ''
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
              />
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Tried on this report only — the set stays as it is, and an empty field uses the set&rsquo;s colour.
        Both end up in <code>palette.typ</code> beside the theme in an export.
      </p>
    </div>
  )
}
