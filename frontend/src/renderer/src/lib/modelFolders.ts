/**
 * The model list's folders, shared by everything that has to agree about them.
 *
 * Three places read this: the Overview list draws it, the New-model dialog offers it, and the import
 * sheet offers it. They must not each hold their own copy — a folder created in the list has to be
 * pickable in the dialog a second later, and a model dropped into a folder has to leave the one it
 * came from everywhere at once. So: one snapshot, one fetch, and subscribers told when it moves.
 *
 * The same shape as `lib/appSettings.ts` on purpose, and for the same reason it earned there: a
 * store that is written through one door and read through a subscription is the only kind that
 * cannot go stale in half the UI while the other half is right.
 */
import { api } from './api'
import { nameMap } from './nameMap'

export interface ModelFolder {
  id: string
  name: string
}

/**
 * Whether the two lists below say anything yet. Before the first read has come back they are empty
 * because nothing is known — and a reader that grouped by them anyway would file every model under
 * Unsorted, which looks exactly like the folders having been deleted. So only `ready` means "these
 * are the folders"; `loading` and `failed` both mean "do not group by them".
 *
 * `failed` is only ever reached from never having read them: once a read succeeded, a later failure
 * keeps the last good state rather than replacing it with nothing.
 */
export type FolderStatus = 'loading' | 'ready' | 'failed'

export interface FolderState {
  /** Always alphabetical — the backend sorts, so nothing here has to remember to. */
  folders: ModelFolder[]
  /** model name → folder id (a `nameMap`). A model that is in none is simply absent. */
  of: Record<string, string>
  status: FolderStatus
}

/** The second read after a failed first one waits this long: a read fails when the backend is busy
 *  (just after start, mostly), and asking again at once would meet it just as busy. */
export const FOLDER_RETRY_MS = 1500

let snapshot: FolderState = { folders: [], of: nameMap(), status: 'loading' }
const subscribers = new Set<() => void>()

function publish(next: FolderState): void {
  snapshot = next
  for (const fn of subscribers) fn()
}

export function getFolders(): FolderState {
  return snapshot
}

export function subscribeFolders(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

const readFolders = (): Promise<Partial<FolderState>> => api('GET', '/api/v1/databases/folders')
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** Which workspace the reads belong to: a read started before the last switch answers for the
 *  workspace that was left, and must not land in the one switched to. */
let workspaceGeneration = 0

/** Re-read from the backend. Called on mount and after every change — including changes made
 *  elsewhere, such as a model being renamed, which moves its membership with it.
 *
 *  A read that fails is tried once more after a pause. If that fails too, what was shown stays
 *  shown: an empty answer would move every model to Unsorted until the next read. */
export async function reloadFolders(): Promise<FolderState> {
  const generation = workspaceGeneration
  // Asked again after giving up (the Overview's "Try again"): back to "on its way", not "failed".
  if (snapshot.status === 'failed') publish({ ...snapshot, status: 'loading' })
  const next = await readFolders()
    .catch(() => pause(FOLDER_RETRY_MS).then(readFolders))
    .catch(() => null)
  if (generation !== workspaceGeneration) return snapshot // the workspace changed while this was out
  if (next)
    publish({ folders: next.folders ?? [], of: nameMap(Object.entries(next.of ?? {})), status: 'ready' })
  // Another read may have succeeded meanwhile; its state stands, and so does any good one before.
  else if (snapshot.status !== 'ready') publish({ ...snapshot, status: 'failed' })
  return snapshot
}

/**
 * The backend now stands in another workspace. What the store holds are the folders of the one that
 * was left — kept, they would sort the new workspace's models into them, and a failed read would keep
 * them for good. So: back to "not known yet", and read this workspace's own. Called by every switch
 * itself, because no reader re-reads on its own when both workspaces happen to hold the same model
 * names, and the New-model dialog never reads at all.
 */
export function resetFolders(): Promise<FolderState> {
  workspaceGeneration++
  publish({ folders: [], of: nameMap(), status: 'loading' })
  return reloadFolders()
}

export async function createFolder(name: string): Promise<ModelFolder> {
  const made = await api<ModelFolder>('POST', '/api/v1/databases/folders', { name })
  await reloadFolders()
  return made
}

export async function renameFolder(id: string, name: string): Promise<void> {
  await api('POST', '/api/v1/databases/folders/rename', { id, name })
  await reloadFolders()
}

/** Deletes the folder, NOT the models in it — they come back unfiled. */
export async function deleteFolder(id: string): Promise<void> {
  await api('POST', '/api/v1/databases/folders/delete', { id })
  await reloadFolders()
}

/** `folderId = null` takes the model out of whatever folder it is in. */
export async function assignFolder(database: string, folderId: string | null): Promise<void> {
  await api('POST', '/api/v1/databases/folders/assign', { database, folder_id: folderId })
  await reloadFolders()
}
