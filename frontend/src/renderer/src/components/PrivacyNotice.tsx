import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import notice from '../assets/privacy-notice.md?raw'
import EscapeCloser from './EscapeCloser'

/**
 * The privacy notice, read inside the app.
 *
 * Rendered from the bundled Markdown (`assets/privacy-notice.md`, a copy of the repo's `PRIVACY.md`),
 * not fetched and not opened as a file: the notice must be readable offline, it belongs to this build
 * (it describes what THIS version sends), and a `.md` handed to the OS lands in whatever editor
 * happens to own the extension — or in a "how do you want to open this" prompt on Windows.
 *
 * Built like every other sheet in the app: `.modal.sheet` with the fixed head
 * (title, one line of subtitle, the ✕) and a body that scrolls on its own, so the ✕ stays put.
 * The Markdown's own H1 and its italic version line become that head; the rest is the body.
 *
 * Portalled into `document.body` for the same reason the skill viewer is (see Settings.tsx): under
 * the settings sheet a fixed-position modal would be clipped to the panel's scroll box.
 */

/** Title, subtitle and body of the notice, taken from the Markdown so the file stays the one source. */
export function splitNotice(md: string): { title: string; subtitle: string; body: string } {
  const lines = md.split('\n')
  const title = (lines[0] ?? '').replace(/^#\s*/, '').trim() || 'Privacy notice'
  let i = 1
  while (i < lines.length && !lines[i].trim()) i++
  let subtitle = ''
  if (lines[i]?.startsWith('*')) {
    subtitle = lines[i].replace(/^\*|\*$/g, '').trim()
    i++
  }
  return { title, subtitle, body: lines.slice(i).join('\n').trim() }
}

export default function PrivacyNotice({ onClose }: { onClose: () => void }): JSX.Element {
  const { title, subtitle, body } = splitNotice(notice)
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div
        className="modal sheet privacy-sheet"
        role="dialog"
        aria-label="Privacy notice"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="privacy-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      </div>
    </div>,
    document.body
  )
}
