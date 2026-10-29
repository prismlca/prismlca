/**
 * The one question the tour asks rather than tells: may the start page load the project news?
 *
 * It sits in the tour's footer bar, right of the dots, on every card (not just the last), unticked by
 * default, and written the moment it changes (no Save
 * buttons). It is NOT the "don't show this again" checkbox the tour deliberately lacks — it does
 * nothing to the tour; Finish is still the only way out. A component because it needs the settings
 * store; the cards themselves are plain JSX.
 */
import { setAS, useAppSettings } from '../lib/appSettings'

/**
 * `highlight`: on the last card the label is swept once with a green highlighter, left to right
 * — the question has sat in the footer for nine cards; this is where it is
 * meant to be noticed. The key remounts the label when the flag flips, so the sweep runs again if
 * the user goes back and returns.
 */
export default function NewsChoice({ highlight = false }: { highlight?: boolean }): JSX.Element {
  const on = useAppSettings().newsAutoLoad === true
  return (
    <label key={highlight ? 'mark' : 'plain'} className={`wt-choice${highlight ? ' wt-choice-mark' : ''}`}>
      <input type="checkbox" checked={on} onChange={(e) => setAS({ newsAutoLoad: e.target.checked })} />
      <span>Load news from prismlca.com at every start</span>
    </label>
  )
}
