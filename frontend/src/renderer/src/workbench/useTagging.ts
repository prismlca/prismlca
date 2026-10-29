/**
 * Everything tags on the Workbench: the shared tag-group catalogue, the per-node tag menu (with its
 * undo-aware re-read), group/value management, group-by-tag boxing, the tag highlight, and the
 * inspector's tag list for the selected node. Extracted from Workbench.tsx (wave 4.1, stage 5).
 *
 * The hook talks to the canvas through its API rather than owning any of it: it selects nodes,
 * re-colours chips (`setTagColors`), highlights (`applyHighlight`) and boxes processes
 * (`putGroups`) — all things the canvas exposes for exactly this kind of consumer.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fetchQuery, invalidate, useQuery } from '../lib/server/useQuery'
import type { TagGroup } from '../lib/server/routes'
import { splitId } from '../lib/canvas'
import { groupsFromTags } from '../lib/groups'
import { boxTags, isBox, shownTags, type BoxData } from '../lib/occurrences'
import type { useCanvasModel } from './useCanvasModel'

// Stable fallback: `?? []` would be a fresh array each render and rattle every dependent memo.
const NO_GROUPS: TagGroup[] = []

type Canvas = ReturnType<typeof useCanvasModel>

export interface TaggingDeps {
  run: (fn: () => Promise<void>) => Promise<void>
  activeDb: string | null
  /** Bumped on every model mutation — the tag menu re-reads on it (undo took a tag back). */
  modelRev: number
  reloadAudit: () => Promise<void>
  setError: (msg: string | null) => void
  setNote: (msg: string | null) => void
  /** Called when group-by-tags drew its boxes — the answer is on the canvas, close the manager. */
  onGrouped: () => void
  canvas: Pick<
    Canvas,
    | 'selected'
    | 'setSelected'
    | 'selectedRef'
    | 'nodesRef'
    | 'onTagRef'
    | 'activeDbRef'
    | 'groupsRef'
    | 'putGroups'
    | 'setSelGroup'
    | 'setTagColors'
    | 'applyHighlight'
    | 'reloadGraph'
    | 'setNodes'
    | 'nodes'
  >
}

// The return type is the API surface; spelling it out would be a hand-kept copy of the signatures.
export function useTagging(deps: TaggingDeps) {
  const { run, activeDb, modelRev, reloadAudit, setError, setNote, onGrouped, canvas } = deps
  const {
    selected,
    setSelected,
    selectedRef,
    nodesRef,
    onTagRef,
    activeDbRef,
    groupsRef,
    putGroups,
    setSelGroup,
    setTagColors,
    applyHighlight,
    reloadGraph
  } = canvas

  // Shared cache: the same key every view reads. The Workbench's own edits invalidate it (see
  // reloadTagGroups), which is what keeps the Results/Report/DetailedResults pickers fresh too.
  const tagGroups = useQuery('/api/v1/model/tag-groups').data?.groups ?? NO_GROUPS
  const [tagMenu, setTagMenu] = useState<{
    id: string
    x: number
    y: number
    current: Record<string, string>
    /** A box's inherited values: what "none" means there (lib/occurrences.ts). */
    inherited?: Record<string, string>
  } | null>(null)
  const [hlTag, setHlTag] = useState<{ dimension: string; value: string } | null>(null) // highlighted tag
  const [hlMenu, setHlMenu] = useState(false)
  const [inspTags, setInspTags] = useState<{ dimension: string; value: string; inherited?: boolean }[]>([])

  // Keep the group→colour map (used for node tag chips) in sync — the canvas holds the ref.
  useEffect(() => {
    setTagColors(new Map(tagGroups.map((g) => [g.name, g.color])))
  }, [tagGroups, setTagColors])
  // Temporarily highlight all nodes carrying the chosen tag (drives the .hl node class).
  useEffect(() => {
    applyHighlight(hlTag)
  }, [hlTag, applyHighlight])

  const reloadTagGroups = useCallback(async () => {
    // Invalidate-then-fetch: awaiting callers (create group, add value) get the fresh list before
    // they continue, and every other subscribed view refetches off the same invalidation.
    invalidate('/api/v1/model/tag-groups')
    await fetchQuery('/api/v1/model/tag-groups')
  }, [])

  const fetchNodeTags = async (id: string): Promise<Record<string, string>> => {
    // A box of an outside dataset carries the tags its inputs share (or a copy's pending ones) on the canvas.
    const box = nodesRef.current.find((n) => n.id === id)
    if (isBox(box)) return Object.fromEntries(boxTags(box).map((t) => [t.dimension, t.value]))
    const [db, code] = splitId(id)
    const tags = await api<{ dimension: string; value: string }[]>(
      'GET',
      `/api/v1/model/tags/${encodeURIComponent(db)}/${encodeURIComponent(code)}`
    )
    return Object.fromEntries(tags.map((t) => [t.dimension, t.value]))
  }

  // Open the per-node tag menu (positioned at the tag button); fetch the node's current tags.
  const openTagMenu = useCallback((id: string, x: number, y: number) => {
    // A click on one of several selected nodes keeps the selection: that is how the bulk assignment
    // below is reached at all — replacing it with the one node made setNodeTag see a single process
    // every time.
    setSelected((prev) => (prev.includes(id) ? prev : [id]))
    const box = nodesRef.current.find((n) => n.id === id)
    const inherited = Object.fromEntries(
      shownTags(box)
        .filter((t) => t.inherited)
        .map((t) => [t.dimension, t.value])
    )
    void run(async () => setTagMenu({ id, x, y, current: await fetchNodeTags(id), inherited }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  onTagRef.current = openTagMenu

  // Set / clear one value in a group for the tag-menu's node (undoable), refresh menu + canvas.
  // When the node is part of a multi-selection, the tag applies to EVERY selected node that can
  // carry tags (editable model processes) in one undoable step.
  const setNodeTag = (group: string, value: string | null): void => {
    const menu = tagMenu
    if (!menu) return
    const ids = selected.includes(menu.id) && selected.length > 1 ? selected : [menu.id]
    const picked = ids.map((id) => nodesRef.current.find((x) => x.id === id)).filter((n) => !!n)
    // Model processes by key; a box by every input that draws on it (one tag for all of them); a copy
    // not yet connected keeps the tag on the canvas until its first input is drawn.
    const keys: Record<string, string>[] = []
    for (const n of picked) {
      if (!(n.data as { readOnly?: boolean }).readOnly) {
        const [database, code] = splitId(n.id)
        keys.push({ database, code })
      } else if (isBox(n)) keys.push(...((n.data as BoxData).uids ?? []).map((uid) => ({ uid })))
    }
    const copies = new Set(
      picked.filter((n) => isBox(n) && !(n.data as BoxData).uids?.length).map((n) => n.id)
    )
    if (copies.size) setPendingTag(copies, group, value)
    if (!keys.length) {
      setTagMenu((m) =>
        m && m.id === menu.id ? { ...m, current: { ...m.current, [group]: value ?? '' } } : m
      )
      return
    }
    void run(async () => {
      await api('POST', '/api/v1/model/tags/set', { keys, group, value })
      // A tagged box gets a new id with its new tags (lib/occurrences.ts): its menu would point at a box
      // that is no longer there, so it closes; a process's menu stays open for the next value.
      if (keys.some((k) => 'uid' in k)) setTagMenu(null)
      else
        setTagMenu((m) =>
          m && m.id === menu.id ? { ...m, current: { ...m.current, [group]: value ?? '' } } : m
        )
      if (activeDb) await reloadGraph(activeDb)
      await reloadAudit()
    })
  }
  // A copy not yet connected: the tag is view state on its card until connectBody hands it to the input.
  const setPendingTag = (ids: Set<string>, group: string, value: string | null): void =>
    canvas.setNodes((ns) =>
      ns.map((n) => {
        if (!ids.has(n.id)) return n
        const kept = boxTags(n).filter((t) => t.dimension !== group)
        const next = value ? [...kept, { dimension: group, value }] : kept
        const color = (t: { dimension: string }) => tagColorFor(t.dimension)
        return {
          ...n,
          data: { ...n.data, pendingTags: next, tags: next.map((t) => ({ ...t, color: color(t) })) }
        }
      })
    )
  const tagColorFor = (dimension: string): string =>
    tagGroups.find((g) => g.name === dimension)?.color ?? 'var(--green)'

  // The menu holds its own copy of the node's tags, set optimistically when it writes — so an Undo
  // from the toolbar left it offering a value the model no longer carried (measured: the
  // undone tag was still selected in the open menu). It re-reads whenever the Workbench wrote, on the
  // same `modelRev` the inspector follows.
  useEffect(() => {
    const id = tagMenu?.id
    if (!id) return
    void fetchNodeTags(id)
      .then((current) => setTagMenu((m) => (m && m.id === id ? { ...m, current } : m)))
      .catch(() => {}) // a menu that cannot refresh must not take the canvas down with it
    // `tagMenu` itself is deliberately not a dependency: opening the menu already fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelRev])

  const createTagGroup = (name: string): void =>
    void run(async () => {
      await api('POST', '/api/v1/model/tag-groups', { name })
      await reloadTagGroups()
    })
  const addTagValue = (group: string, value: string): void =>
    void run(async () => {
      await api('POST', '/api/v1/model/tag-groups/values', { group, value })
      await reloadTagGroups()
    })

  // Tag-group management (toolbar "Tag" button). Deleting a group/value cascades on the backend
  // (untags every process), so the canvas + audit must reload afterwards.
  const deleteTagGroup = (name: string): void =>
    void run(async () => {
      await api('POST', '/api/v1/model/tag-groups/delete', { name })
      await reloadTagGroups()
      if (activeDb) await reloadGraph(activeDb)
      await reloadAudit()
    })

  /**
   * One box per tag of a tag group — the button in the tag window.
   *
   * The rule that makes this possible is checked on the backend, not here (see
   * `model.partition_by_tag_group`): one box per tag only means something if each process carries at
   * most one tag from the group, and the canvas can only see the processes that are drawn while the
   * *model* is what the claim is about. A violation is refused **by name**: "it would not work" is not
   * something the user can act on, "these three processes carry two Phase tags each" is.
   */
  const groupByTagGroup = useCallback(
    (group: string) => {
      const db = activeDbRef.current
      if (!db) return
      void run(async () => {
        const r = await api<{
          partition: { value: string; members: string[] }[]
          conflicts: { id: string; name: string; values: string[] }[]
          untagged: string[]
        }>('POST', '/api/v1/model/tag-groups/partition', { database: db, group })
        if (r.conflicts.length) {
          const named = r.conflicts.slice(0, 6).map((c) => `“${c.name}”`)
          const rest = r.conflicts.length - named.length
          setNote(null)
          setError(
            `Cannot group by “${group}”: one box per tag needs every process to carry at most one ${group} tag, and ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} carr${r.conflicts.length === 1 ? 'ies' : 'y'} several. Clear the extra tags on ${r.conflicts.length === 1 ? 'it' : 'them'} first.`
          )
          return
        }
        const made = groupsFromTags(groupsRef.current, r.partition)
        if (!made.created.length) {
          setError(null)
          setNote(
            `Nothing to group by “${group}”: no tag of that group is on two or more processes, and a box around a single process says nothing.`
          )
          return
        }
        putGroups(made.groups, `Group by ${group}`)
        setSelGroup(null)
        onGrouped() // the answer is on the canvas, so get out of the way of it
        const parts = [`Grouped by “${group}”: ${made.created.length} boxes.`]
        if (made.skipped.length)
          parts.push(
            `${made.skipped.map((v) => `“${v}”`).join(', ')} ${made.skipped.length === 1 ? 'has' : 'have'} a single process and got no box.`
          )
        if (r.untagged.length)
          parts.push(`${r.untagged.length} processes carry no ${group} tag and are in no box.`)
        if (made.moved) parts.push(`${made.moved} moved out of a box they were already in.`)
        setError(null)
        setNote(parts.join(' '))
      })
    },
    [putGroups, run, activeDbRef, groupsRef, setSelGroup, onGrouped, setError, setNote]
  )

  const removeTagValue = (group: string, value: string): void =>
    void run(async () => {
      await api('POST', '/api/v1/model/tag-groups/values/remove', { group, value })
      await reloadTagGroups()
      if (activeDb) await reloadGraph(activeDb)
      await reloadAudit()
    })
  // Merging retags instead of untagging (V385): the processes keep a phase, the vocabulary loses a
  // spelling. Both cascade over every model, so canvas + audit reload like after a removal.
  const mergeTagValue = (group: string, value: string, into: string): void =>
    void run(async () => {
      await api('POST', '/api/v1/model/tag-groups/values/merge', { group, value, into })
      await reloadTagGroups()
      if (activeDb) await reloadGraph(activeDb)
      await reloadAudit()
    })
  const mergeTagGroup = (name: string, into: string): void =>
    void run(async () => {
      await api('POST', '/api/v1/model/tag-groups/merge', { name, into })
      await reloadTagGroups()
      if (activeDb) await reloadGraph(activeDb)
      await reloadAudit()
    })

  // The inspector's tag list for a single selected node. It re-reads on `modelRev` (a tag written, an
  // Undo) and, for a box, when the tags on its card change — a copy not yet connected keeps them only there.
  const selBox = selected.length === 1 ? canvas.nodes.find((n) => n.id === selected[0]) : undefined
  const boxKey = isBox(selBox) ? JSON.stringify(shownTags(selBox)) : ''
  useEffect(() => {
    if (selected.length === 1) {
      const target = selected[0]
      const box = nodesRef.current.find((n) => n.id === target)
      if (isBox(box)) {
        setInspTags(shownTags(box))
        return
      }
      const [db, code] = splitId(target)
      void run(async () => {
        const tags = await api<{ dimension: string; value: string }[]>(
          'GET',
          `/api/v1/model/tags/${encodeURIComponent(db)}/${encodeURIComponent(code)}`
        )
        // Guard against out-of-order responses when selecting nodes in quick succession.
        if (selectedRef.current[0] === target) setInspTags(tags)
      })
    } else {
      setInspTags([])
    }
  }, [selected, modelRev, boxKey, run, selectedRef, nodesRef])

  return {
    tagGroups,
    reloadTagGroups,
    tagMenu,
    setTagMenu,
    setNodeTag,
    createTagGroup,
    addTagValue,
    deleteTagGroup,
    removeTagValue,
    mergeTagValue,
    mergeTagGroup,
    groupByTagGroup,
    hlTag,
    setHlTag,
    hlMenu,
    setHlMenu,
    inspTags
  }
}
