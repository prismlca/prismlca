import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import licenceText from '../../../../resources/LICENSE.txt?raw'
import {
  LICENCE_BLURB,
  LICENCE_NAME,
  NOTICES_BLURB,
  NOTICES_LABEL,
  NOTICES_PROVENANCE
} from '../../../shared/licence'
import { GITHUB_URL, openLink } from '../lib/links'
import EscapeCloser from './EscapeCloser'

/**
 * The licence and the third-party notices, read inside the app.
 *
 * Both texts still ship as files — `resources/LICENSE.txt` and `resources/THIRD-PARTY-NOTICES.md` —
 * because that is what the licences require: a copy the user can read and pass on. The sheets are
 * the comfortable way in; each has an "open the file" button for the copy itself. Same shape as
 * every other sheet (fixed head with the ✕, a body that scrolls on its own, a footer), and portalled
 * into `document.body` so they are not clipped when opened from under the settings sheet.
 *
 * The licence text is imported straight from the bundled file, so what the sheet shows IS the file.
 * The notices are 2 MB of licence texts; the sheet shows only their summary tables (fetched from main,
 * see main/licence.ts) and leaves the whole to the file.
 */

function Sheet({
  title,
  subtitle,
  label,
  onClose,
  children,
  foot
}: {
  title: string
  subtitle: ReactNode
  label: string
  onClose: () => void
  children: ReactNode
  foot: ReactNode
}): JSX.Element {
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div
        className="modal sheet legal-sheet"
        role="dialog"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="legal-body">{children}</div>
        <div className="sheet-foot">{foot}</div>
      </div>
    </div>,
    document.body
  )
}

/** PrismLCA's own licence, the AGPL-3.0 text with the §7 permission at its end. */
export function LicenceSheet({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Sheet
      title={LICENCE_NAME}
      label="Licence"
      onClose={onClose}
      subtitle={LICENCE_BLURB}
      foot={
        <>
          <span className="meta">
            Source code:{' '}
            <button className="link-btn" onClick={() => openLink(GITHUB_URL)} title={`Open ${GITHUB_URL}`}>
              {GITHUB_URL.replace(/^https?:\/\//, '')}
            </button>
          </span>
          <span className="sheet-foot-grow" />
          <button className="btn" onClick={() => void window.prism.openLicence()}>
            Open as file
          </button>
        </>
      }
    >
      <pre className="legal-pre">{licenceText}</pre>
    </Sheet>
  )
}

/** The third-party notices: the summary tables here, the full texts in the file. */
export function NoticesSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const [summary, setSummary] = useState<{ text: string; error?: string } | null>(null)
  useEffect(() => {
    let live = true
    void window.prism
      .noticesSummary()
      .then((r) => {
        if (live) setSummary(r)
      })
      .catch((e: unknown) => {
        if (live) setSummary({ text: '', error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      live = false
    }
  }, [])
  return (
    <Sheet
      title={NOTICES_LABEL}
      label={NOTICES_LABEL}
      onClose={onClose}
      subtitle={NOTICES_BLURB}
      foot={
        <>
          <span className="meta">{NOTICES_PROVENANCE}</span>
          <span className="sheet-foot-grow" />
          <button className="btn" onClick={() => void window.prism.openNotices()}>
            Open the full notices
          </button>
        </>
      }
    >
      {summary === null ? (
        <p className="settings-hint">Loading…</p>
      ) : summary.error ? (
        <p className="settings-hint bad">{summary.error}</p>
      ) : (
        <div className="legal-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.text}</ReactMarkdown>
        </div>
      )}
    </Sheet>
  )
}
