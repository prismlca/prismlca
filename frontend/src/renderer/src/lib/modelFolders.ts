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

export interface ModelFolder {
  id: string
  name: string
}

export interface FolderState {
  /** Always alphabetical — the backend sorts, so nothing here has to remember to. */
  folders: ModelFolder[]
  /** model name → folder id. A model that is in none is simply absent. */
  of: Record<string, string>
}

let snapshot: FolderState = { folders: [], of: {} }
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

/** Re-read from the backend. Called on mount and after every change — including changes made
 *  elsewhere, such as a model being renamed, which moves its membership with it. */
export async function reloadFolders(): Promise<FolderState> {
  const next = await api<FolderState>('GET', '/api/v1/databases/folders').catch(() => ({
    folders: [],
    of: {}
  }))
  publish({ folders: next.folders ?? [], of: next.of ?? {} })
  return snapshot
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
