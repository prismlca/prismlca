/**
 * Comparison models — "B is compared with A" as a property of the study, symmetric and pairwise.
 * The backend keeps it in both models' study metadata; this module is the
 * renderer's one way to read and change it, so the Info dialog and the chat's "+" menu cannot drift.
 *
 * Reads go through the query cache under the study route, which is what every other reader of the
 * study uses — a link made in the Info dialog therefore shows up in an open chat without a reload.
 */
import { useMemo } from 'react'
import { api } from './api'
import { studyRoute } from './server/routes'
import { invalidate, useQuery } from './server/useQuery'

/** The models `db` is compared with, live. `[]` while loading, for no model, or for none linked. */
export function useComparedWith(db: string | null): string[] {
  const { data } = useQuery(db ? studyRoute(db) : null)
  const raw = (data as { compared_with?: unknown } | undefined)?.compared_with
  // Same list → same array: callers put it in effect and callback dependencies.
  const key = JSON.stringify(Array.isArray(raw) ? raw : [])
  return useMemo(
    () => (JSON.parse(key) as unknown[]).filter((n): n is string => typeof n === 'string'),
    [key]
  )
}

async function refresh(a: string, b: string): Promise<void> {
  invalidate(studyRoute(a))
  invalidate(studyRoute(b))
}

/** Make the two models comparison models of each other (both sides, undoable). */
export async function linkModels(database: string, other: string): Promise<void> {
  await api('POST', '/api/v1/study/link', { database, other, source: 'user' })
  await refresh(database, other)
}

/** Stop comparing the two models (both sides, undoable). */
export async function unlinkModels(database: string, other: string): Promise<void> {
  await api('POST', '/api/v1/study/unlink', { database, other, source: 'user' })
  await refresh(database, other)
}
