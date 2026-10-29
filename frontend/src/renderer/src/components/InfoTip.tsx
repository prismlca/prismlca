import type { ReactNode } from 'react'

import { InfoIcon } from './icons'

/**
 * The explanation a field used to carry as a paragraph under it, one hover away instead.
 *
 * Why a panel and not the native `title=`: that appears after a delay the reader has to sit
 * through, wraps where the platform decides, and renders three sentences as an unreadable strip.
 * These texts are the reason a setting exists — worth reading, not worth the vertical space of six
 * paragraphs stacked between six pickers, which is what pushed the pickers themselves off the
 * screen.
 *
 * Hover OR keyboard focus opens it, both in CSS: no state, so it cannot get stuck open, and it
 * survives a re-render mid-hover. The button is `type="button"` and swallows its click because
 * these sit inside a `<label>`, where any click would otherwise land on the field.
 */
export function InfoTip({ children, label }: { children: ReactNode; label: string }): JSX.Element {
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-tip-btn"
        aria-label={`About ${label}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <InfoIcon />
      </button>
      <span className="info-tip-panel" role="tooltip">
        {children}
      </span>
    </span>
  )
}
