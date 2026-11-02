/**
 * Deleting several nodes at once: the Delete key on a multi-selection, or the node menu's Delete and Remove
 * on the part of the selection they apply to. One question names the count. The model's processes go
 * through the backend, each an undo step; two or more passes let consumer links INSIDE the selection resolve
 * themselves. Locked references leave the canvas afterwards, with the inputs they feed into the model.
 *
 * A process that something outside the selection still draws on is not deleted with the rest. It is asked
 * about afterwards, one after the other, with the same question Delete asks for a single process — naming
 * who still uses it — and only a yes deletes it (undo restores the links). The questions stop when a forced
 * delete fails, so its error stays in view, and when another model has been opened meanwhile: nothing of
 * this model's may then touch that canvas.
 */
import { useCallback, type MutableRefObject } from 'react'
import type { Edge, Node } from '@xyflow/react'

import { api, ApiError } from '../lib/api'
import { splitId } from '../lib/canvas'
import { workspaceGeneration } from '../lib/modelView'
import type { ConfirmSpec } from '../views/ConfirmDialog'
import { blockedConsumers, deleteManyQuestion, inUseMessage } from './inUse'

type Consumers = ReturnType<typeof blockedConsumers>

export interface DeleteSelectionDeps {
  run: (fn: () => Promise<void>) => Promise<void>
  activeDb: string | null
  /** The model open now — compared with the one the delete began in after every wait. */
  activeDbRef: MutableRefObject<string | null>
  selected: string[]
  setSelected: (ids: string[]) => void
  setConfirm: (spec: ConfirmSpec | null) => void
  nodesRef: MutableRefObject<Node[]>
  edgesRef: MutableRefObject<Edge[]>
  setNodes: (nodes: Node[]) => void
  setEdges: (edges: Edge[]) => void
  posRef: MutableRefObject<Record<string, { x: number; y: number }>>
  colorsRef: MutableRefObject<Record<string, string>>
  setColorRef: MutableRefObject<(id: string, color: string) => void>
  dropGroupsRef: MutableRefObject<(ids: string[]) => void>
  /** The revealed upstream that goes with a removed reference (useCanvasModel). */
  removeClosure: (seed: Set<string>) => Set<string>
  /** What Undo brings back with a deleted node (useBoxes). */
  stash: (ids: Iterable<string>) => void
  reloadGraph: (db: string) => Promise<unknown>
  reloadAudit: () => Promise<void>
}

export function useDeleteSelection(deps: DeleteSelectionDeps) {
  const { run, activeDb, activeDbRef, selected, setSelected, setConfirm, nodesRef, edgesRef } = deps
  const { setNodes, setEdges } = deps
  const { posRef, colorsRef, setColorRef, dropGroupsRef, removeClosure, stash, reloadGraph, reloadAudit } =
    deps

  return useCallback(
    (only?: string[]) => {
      const ids = only ?? [...selected]
      if (ids.length < 2) return
      const isFg = (id: string): boolean => {
        const n = nodesRef.current.find((x) => x.id === id)
        return splitId(id)[0] === activeDb && !(n?.data as { readOnly?: boolean } | undefined)?.readOnly
      }
      const fg = ids.filter(isFg)
      const refs = ids.filter((id) => !isFg(id))
      const feeds = edgesRef.current.filter(
        (e) => refs.includes(e.source) && isFg(e.target) && (e.data as { uid?: string })?.uid
      )
      // Still on the canvas this began on: after a switch the refs and writers below belong to another model.
      const generation = workspaceGeneration()
      const here = (): boolean => activeDbRef.current === activeDb && workspaceGeneration() === generation
      const reload = async (): Promise<void> => {
        if (!activeDb || !here()) return
        await reloadGraph(activeDb)
        await reloadAudit()
      }
      // A deleted process keeps nothing on the canvas — Undo gets it back from the stash.
      const forget = (id: string): void => {
        if (!here()) return
        stash([id])
        delete posRef.current[id]
        if (colorsRef.current[id]) setColorRef.current(id, '')
      }
      const label = (id: string): string =>
        (nodesRef.current.find((n) => n.id === id)?.data as { label?: string } | undefined)?.label ??
        splitId(id)[1]

      // One question per process still in use, in turn. The next one is put up after this one has closed —
      // the dialog closes itself right after its answer, which would otherwise take the next one with it.
      const askInUse = (left: [string, Consumers][], at: number, of: number): void => {
        if (!left.length || !here()) return
        const [[id, consumers], ...rest] = left
        const [db, code] = splitId(id)
        setConfirm({
          title: of > 1 ? `Process is in use (${at} of ${of})` : 'Process is in use',
          message: inUseMessage(label(id), db, consumers),
          confirmLabel: 'Delete anyway',
          danger: true,
          onConfirm: () =>
            void run(async () => {
              // A failure ends the questions (run shows it); the processes not asked about yet stay.
              await api('POST', '/api/v1/model/activities/delete', { database: db, code, force: true })
              if (!here()) return
              forget(id)
              dropGroupsRef.current([id])
              await reload()
              askInUse(rest, at + 1, of)
            }),
          onCancel: () => void Promise.resolve().then(() => askInUse(rest, at + 1, of))
        })
      }

      setConfirm({
        ...deleteManyQuestion(fg.length, refs.length, feeds.length),
        danger: true,
        onConfirm: () =>
          void run(async () => {
            let queue = fg
            const inUse = new Map<string, Consumers>()
            // Passes until one changes nothing: a chain A→B→C selected in supplier order frees exactly one
            // process per pass, and two fixed passes left A standing with a message that blamed a consumer
            // outside the selection.
            for (let progress = true; progress && queue.length; ) {
              const blocked: string[] = []
              for (const id of queue) {
                const [db, code] = splitId(id)
                try {
                  await api('POST', '/api/v1/model/activities/delete', { database: db, code })
                  forget(id)
                  inUse.delete(id)
                } catch (e) {
                  if (!(e instanceof ApiError && e.code === 'delete_blocked')) throw e
                  blocked.push(id)
                  inUse.set(id, blockedConsumers(e.details))
                }
              }
              progress = blocked.length < queue.length
              queue = blocked
            }
            if (!here()) return // the deletes are this model's undo steps; its canvas is not on screen now
            // Selected references: drop their exchanges into SURVIVING model processes, then
            // remove them (and exclusively-upstream revealed nodes) from the canvas.
            const removedRefs: string[] = []
            if (refs.length) {
              const remove = removeClosure(new Set(refs))
              removedRefs.push(...remove)
              const feed = edgesRef.current.filter(
                (e) =>
                  remove.has(e.source) &&
                  splitId(e.target)[0] === activeDb &&
                  !remove.has(e.target) &&
                  !fg.includes(e.target) &&
                  (e.data as { uid?: string })?.uid
              )
              for (const e of feed) {
                const [adb, acode] = splitId(e.target)
                await api('POST', '/api/v1/model/exchanges/remove', {
                  activity_database: adb,
                  activity_code: acode,
                  uid: (e.data as { uid: string }).uid
                })
              }
              stash(remove)
              remove.forEach((r) => {
                delete posRef.current[r]
                if (colorsRef.current[r]) setColorRef.current(r, '')
              })
              nodesRef.current = nodesRef.current.filter((n) => !remove.has(n.id))
              edgesRef.current = edgesRef.current.filter(
                (e) => !remove.has(e.source) && !remove.has(e.target)
              )
              setNodes(nodesRef.current)
              setEdges(edgesRef.current)
            }
            // Deleted, not merely off-canvas: a collapsed node comes back, a deleted one does not, so
            // this is the moment membership is forgotten (see pruneGroups).
            dropGroupsRef.current([...fg.filter((id) => !queue.includes(id)), ...removedRefs])
            setSelected([])
            await reload()
            const ask = queue.map((id): [string, Consumers] => [id, inUse.get(id) ?? []])
            askInUse(ask, 1, ask.length)
          })
      })
    },
    // The refs and ref-held writers are stable; listed so the rule can check the rest.
    [
      selected,
      activeDb,
      activeDbRef,
      run,
      setConfirm,
      setSelected,
      setNodes,
      setEdges,
      nodesRef,
      edgesRef,
      posRef,
      colorsRef,
      setColorRef,
      dropGroupsRef,
      removeClosure,
      stash,
      reloadGraph,
      reloadAudit
    ]
  )
}
