import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { colorsParam, type PaletteColors } from './PalettePicker'

/** Theme previews: a rendered cover per theme, fetched once and kept for the session.
 *
 * A theme's label can only hint at what it looks like — "Curved band" and "Shapes and card" are two very
 * different pages, and the only honest way to choose between them is to look at them. The backend
 * typesets the cover with sample data and caches it by the hash of the template source, so this side only
 * has to avoid asking twice.
 *
 * Module-level, not React state: the same preview is wanted by the picker and by the Themes window, and a
 * cover does not change while the app is open unless the theme is re-uploaded — which mints a new hash and
 * so a new request anyway. */
const CACHE = new Map<string, string>()
const PENDING = new Map<string, Promise<string>>()

/** Keyed by theme, colour set *and* the three a report picked by hand: the same layout in other colours is
 *  a different picture, and the gallery shows every cover in the colours the report is actually typeset in. */
const key = (name: string, palette?: string, colors?: PaletteColors): string =>
  `${name}\u0000${palette ?? ''}\u0000${colorsParam(colors)}`

/** Forget every rendered preview — on a project switch: custom themes are per project, and one named
 *  "custom" in the next project showed the previous project's picture. */
export function resetThemePreviews(): void {
  CACHE.clear()
  PENDING.clear()
}

export function themePreview(name: string, palette?: string, colors?: PaletteColors): Promise<string> {
  const k = key(name, palette, colors)
  const hit = CACHE.get(k)
  if (hit) return Promise.resolve(hit)
  const running = PENDING.get(k)
  if (running) return running
  const own = colorsParam(colors)
  const params = [
    palette ? `palette=${encodeURIComponent(palette)}` : '',
    own ? `colors=${encodeURIComponent(own)}` : ''
  ].filter(Boolean)
  const q = params.length ? `?${params.join('&')}` : ''
  const request = api<{ base64: string }>(
    'GET',
    `/api/v1/report/templates/${encodeURIComponent(name)}/preview${q}`
  )
    .then((r) => {
      CACHE.set(k, r.base64)
      PENDING.delete(k)
      return r.base64
    })
    .catch((e) => {
      PENDING.delete(k)
      throw e
    })
  PENDING.set(k, request)
  return request
}

/** Forget a theme's preview — after an upload that replaced it under the same name. Every palette of it,
 *  since the source behind all of them changed. */
export function forgetThemePreview(name: string): void {
  for (const k of [...CACHE.keys()]) if (k.startsWith(`${name}\u0000`)) CACHE.delete(k)
  for (const k of [...PENDING.keys()]) if (k.startsWith(`${name}\u0000`)) PENDING.delete(k)
}

/** One preview image, loading itself. `size` is the CSS class suffix: a row thumbnail or a hover card. */
export default function ThemePreview({
  name,
  palette,
  colors,
  variant = 'card'
}: {
  name: string
  /** The report's colour set, so the cover is shown in the colours it will be typeset in. */
  palette?: string
  /** And the three it overrides by hand, for the same reason. */
  colors?: PaletteColors
  /** `tile` fills its column at A4 proportions — the gallery's card. */
  variant?: 'card' | 'thumb' | 'tile'
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(CACHE.get(key(name, palette, colors)) ?? null)
  const [failed, setFailed] = useState(false)
  // The theme can change under a mounted component (hovering down a list), so the request is tied to the
  // name it was made for and a late answer for a different one is dropped.
  const wanted = useRef(key(name, palette, colors))
  const own = colorsParam(colors)

  useEffect(() => {
    const k = key(name, palette, colors)
    wanted.current = k
    const hit = CACHE.get(k)
    setSrc(hit ?? null)
    setFailed(false)
    if (hit) return
    themePreview(name, palette, colors)
      .then((b64) => {
        if (wanted.current === k) setSrc(b64)
      })
      .catch(() => {
        if (wanted.current === k) setFailed(true)
      })
    // `own` and not `colors`: the object is new on every render of the panel, and depending on it would
    // re-request every tile on every keystroke elsewhere in the rail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, palette, own])

  const cls = `theme-preview ${variant}`
  if (failed) return <span className={`${cls} empty`} title="This theme's cover could not be typeset" />
  if (!src) return <span className={`${cls} empty`} aria-hidden="true" />
  return <img className={cls} src={`data:image/png;base64,${src}`} alt={`Cover of ${name}`} />
}
