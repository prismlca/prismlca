import { STUDY_NAV } from '../workbench/AppSidebar'

/**
 * The app's own rail, rendered from the app's own list and the app's own classes.
 *
 * Not a drawing of it: `STUDY_NAV` and `.navitem`/`.ic`/`.navitem-mark` are the very things the
 * sidebar uses, so the icons, the order and the active row's green can never drift from what the
 * user sees three centimetres to the left. The only thing left out is the sliding pill, which is
 * measured at runtime in the sidebar — here the active row simply carries the pill's colour.
 */
export default function RailPreview(): JSX.Element {
  return (
    <div className="wt-rail">
      <div className="navlist">
        {STUDY_NAV.map((it) => (
          <div key={it.label} className={`navitem${it.label === 'Model' ? ' on' : ''}`}>
            <span className="ic">
              <it.icon />
            </span>
            <span className="navitem-label">{it.label}</span>
            <span className="navitem-mark" aria-hidden="true">
              ›
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
