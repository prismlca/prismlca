/**
 * What the Overview's model list says in place of its folders while it does not know them yet.
 *
 * The list is grouped by folder, and grouping by folders that have not arrived puts every model under
 * Unsorted — a picture of the folders having been deleted. So until they are read the list shows this
 * line and no models at all. If they cannot be read even on the second try, it says so and offers to
 * try again: the folders and the models in them are still where they were, only unread.
 */
import type { FolderStatus } from '../../lib/modelFolders'

export default function FoldersPending({
  status,
  onRetry
}: {
  status: Exclude<FolderStatus, 'ready'>
  onRetry: () => void
}): JSX.Element {
  if (status === 'loading') return <div className="ov-empty">Loading folders…</div>
  return (
    <div className="ov-empty" role="alert">
      The folders could not be read, so the models are not listed yet.{' '}
      <button className="link-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}
