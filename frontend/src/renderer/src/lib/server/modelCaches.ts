/**
 * The cached reads that hold the open model's data, and the one step that marks them stale.
 *
 * Every model mutation ends here — the Workbench after its own edits, undo and redo, and every edit the
 * assistant makes, whichever view is on screen at the time — so each of these keys goes stale on the same
 * occasions. A key that belongs to the model's data and is missing here stays as the first reader found it.
 */
import { invalidate } from './useQuery'

const MODEL_CACHES = [
  '/api/v1/model/activities',
  '/api/v1/model/graph',
  '/api/v1/model/unit-vocabulary',
  // A model's tag groups, and the groups in use that the result pickers offer: a first tag assignment
  // (or its undo) changes the second without touching the groups themselves. One prefix, both routes.
  '/api/v1/model/tag-groups',
  '/api/v1/study',
  '/api/v1/scenarios'
]

export function invalidateModelCaches(): void {
  for (const prefix of MODEL_CACHES) invalidate(prefix)
}
