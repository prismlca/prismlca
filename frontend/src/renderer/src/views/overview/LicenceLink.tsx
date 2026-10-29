import { useState } from 'react'
import { LICENCE_LABEL, LICENCE_NAME, NOTICES_LABEL } from '../../../../shared/licence'
import { LicenceIcon } from '../../components/icons'
import { LicenceSheet, NoticesSheet } from '../../components/LegalSheets'

/**
 * "Licence: AGPL-3.0 · Third-party notices" for the start page's footer. Both labels open a sheet
 * inside the app (components/LegalSheets.tsx); the bundled files behind them stay where the licences
 * want them, and each sheet has a button for the file itself. Not web links: the texts must be
 * readable offline, and they belong to this build, not to whatever the website says today. The
 * separator is the footer's own drawn dot (`.ov-meta-sep`), not a "·".
 *
 * `plain` renders the two labels as in-text links without the icon, for Settings → About.
 */
export default function LicenceLink({ plain }: { plain?: boolean }): JSX.Element {
  const [open, setOpen] = useState<'licence' | 'notices' | null>(null)
  const cls = plain ? 'link-btn' : 'ov-meta-link'
  const licence = (
    <button
      className={cls}
      onClick={() => setOpen('licence')}
      title={`Read the licence text (${LICENCE_NAME})`}
    >
      {LICENCE_LABEL}
    </button>
  )
  const notices = (
    <button className={cls} onClick={() => setOpen('notices')} title="Read the third-party notices">
      {NOTICES_LABEL}
    </button>
  )
  return (
    <>
      {plain ? (
        <>
          {licence} and {notices}
        </>
      ) : (
        <span className="ov-meta-licence">
          <LicenceIcon /> Licence:
          {licence}
          <span className="ov-meta-sep" aria-hidden="true" />
          {notices}
        </span>
      )}
      {open === 'licence' ? <LicenceSheet onClose={() => setOpen(null)} /> : null}
      {open === 'notices' ? <NoticesSheet onClose={() => setOpen(null)} /> : null}
    </>
  )
}
