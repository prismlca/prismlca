/**
 * "Last models" on the start page: which models the user opened, per project, newest first.
 *
 * Stored in the app settings (`recentModels`, userData/settings.json) rather than in the project:
 * which model somebody looked at last is a fact about this machine, not about the study, and it must
 * not travel in an exported bundle. Written whole — main merges settings shallowly — and cleaned by
 * the shared sanitiser on both sides (shared/startPage.ts), so dedupe, order and cap live in one place.
 *
 * Only a USER's open is recorded (the Workbench's `openModel`): restoring the model that was open at
 * the last start, or falling back to another after a delete, is not somebody picking up a model.
 */
import { getAS, setAS } from './appSettings'
import { sanitiseRecentModels, type RecentModel } from '../../../shared/startPage'

/** The list after opening `db` in `project` now. Pure — the store helpers below write it. */
export function withOpened(
  list: RecentModel[],
  project: string,
  db: string,
  now = new Date()
): RecentModel[] {
  return sanitiseRecentModels([{ project, db, openedAt: now.toISOString() }, ...list])
}

/** The list after `from` was renamed to `to` in `project`: the entry follows the model. */
export function withRenamed(list: RecentModel[], project: string, from: string, to: string): RecentModel[] {
  return sanitiseRecentModels(
    list.map((r) => (r.project === project && r.db === from ? { ...r, db: to } : r))
  )
}

const current = (): RecentModel[] => sanitiseRecentModels(getAS().recentModels)

export function rememberRecentModel(project: string, db: string): void {
  if (!db) return
  setAS({ recentModels: withOpened(current(), project, db) })
}

export function renameRecentModel(project: string, from: string, to: string): void {
  if (!from || !to || from === to) return
  const list = current()
  if (!list.some((r) => r.project === project && r.db === from)) return // nothing to move, nothing to write
  setAS({ recentModels: withRenamed(list, project, from, to) })
}

/** The current project's opens, newest first. Whether the model still exists is the caller's
 *  question — it holds the database list. */
export function recentModelsFor(project: string, list: unknown = getAS().recentModels): RecentModel[] {
  return sanitiseRecentModels(list).filter((r) => r.project === project)
}
