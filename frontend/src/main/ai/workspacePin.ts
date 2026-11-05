/**
 * The workspace a chat turn or a report-writer run belongs to. Read once when the run starts and named on
 * every backend request of the run (`X-Prism-Project`, percent-encoded like the MCP sessions send it), so
 * the backend's project guard answers a request after a workspace switch with 409 instead of serving it
 * from the model of the same name in the new workspace.
 *
 * Electron-free.
 */
import type { ApiRaw } from './execute'

/** The active workspace as the backend's project guard reads it; null when it cannot be read. */
export async function activeWorkspace(apiRaw: ApiRaw): Promise<string | null> {
  try {
    const { status, body } = await apiRaw('GET', '/api/v1/system/info')
    if (status >= 400) return null
    const name = (body as { current_project?: { name?: unknown } | null } | null)?.current_project?.name
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}

/** `apiRaw` with every request pinned to `project`; unchanged when there is none. The pin wins over a
 *  caller's own headers. */
export function pinnedTo(project: string | null, apiRaw: ApiRaw): ApiRaw {
  if (!project) return apiRaw
  const pin = { 'X-Prism-Project': encodeURIComponent(project) }
  return (method, path, body, extra) => apiRaw(method, path, body, { ...extra, ...pin })
}

/** `apiRaw` pinned to the workspace that is active now. */
export async function pinnedToActiveWorkspace(apiRaw: ApiRaw): Promise<ApiRaw> {
  return pinnedTo(await activeWorkspace(apiRaw), apiRaw)
}
