/**
 * An external link on a tour card, opened in the real browser.
 *
 * A plain `<a href>` inside Electron would navigate the app window away from PrismLCA, so every
 * external link in this app goes through `openExternal` (see main/coreIpc.ts, which also refuses
 * anything that is not http(s)). A button rather than an anchor, because that is what it is: there
 * is no href to copy, middle-click or open in a tab.
 */
export default function TourLink({ href }: { href: string }): JSX.Element {
  return (
    <button
      type="button"
      className="wt-link"
      title={`Open ${href}`}
      onClick={() => void window.prism.openExternal(href.startsWith('http') ? href : `https://${href}`)}
    >
      {href}
    </button>
  )
}
