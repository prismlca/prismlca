import { useState } from 'react'
import { LockIcon } from '../../components/icons'
import PrivacyNotice from '../../components/PrivacyNotice'

/**
 * "Privacy notice" for the start page's footer, beside the licence. The label opens the bundled
 * notice in a modal (components/PrivacyNotice.tsx) — readable offline and tied to this build, which
 * is the point: GDPR Art. 12 asks for the notice to be easily accessible, and the start page is
 * the first thing every user sees. The same button serves Settings and the welcome tour through
 * the `plain` variant, which drops the footer's icon and class.
 */
export default function PrivacyLink({ plain }: { plain?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const button = (
    <button
      className={plain ? 'link-btn' : 'ov-meta-link'}
      onClick={() => setOpen(true)}
      title="What PrismLCA sends, to whom, and when — nothing without your say-so"
    >
      Privacy notice
    </button>
  )
  return (
    <>
      {plain ? (
        button
      ) : (
        <span className="ov-meta-privacy">
          <LockIcon /> {button}
        </span>
      )}
      {open ? <PrivacyNotice onClose={() => setOpen(false)} /> : null}
    </>
  )
}
