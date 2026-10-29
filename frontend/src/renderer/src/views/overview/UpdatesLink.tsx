import { UpdateIcon } from '../../components/icons'

/**
 * "Check for updates" beside the version in the start page's footer. It only opens Settings → About,
 * where the check itself runs on its own button: the link must not send anything, because PrismLCA
 * asks github.com for a release only when the person clicks the button that says so (see PRIVACY.md).
 */
export default function UpdatesLink({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <span>
      <UpdateIcon />
      <button
        className="ov-meta-link"
        onClick={onOpen}
        title="Open Settings → About to check for a newer release"
      >
        Check for updates
      </button>
    </span>
  )
}
