/**
 * Node colours on the canvas: the model's colour map, the writers that paint and clear it — each persisting
 * to the model's view — and its reflection onto the live nodes. View state like the group boxes: a colour
 * says nothing about the LCA. A colour the user paints is a step of the canvas's undo history
 * (lib/viewHistory.ts); the cleanup writer the delete paths use is not, its step is the deletion.
 */
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { Node } from '@xyflow/react'

import { viewSet } from '../lib/modelView'

export interface NodeColorDeps {
  activeDbRef: MutableRefObject<string | null>
  selectedRef: MutableRefObject<string[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  /** Note a step of the canvas's undo history before a change the user made (workbench/useViewHistory.ts). */
  rememberRef: MutableRefObject<(label: string) => void>
  /** Kept current here, read by the canvas: the colour map, the cleanup writer, the palette's painter. */
  colorsRef: MutableRefObject<Record<string, string>>
  setColorRef: MutableRefObject<(id: string, color: string) => void>
  paintSelRef: MutableRefObject<(id: string, color: string) => void>
}

export function useNodeColors(deps: NodeColorDeps) {
  const { activeDbRef, selectedRef, setNodes, rememberRef, colorsRef, setColorRef, paintSelRef } = deps
  // Node colours belong to the model, not to the browser (and used to be stored globally, so one
  // model's colours were the next one's too). Seeded per model by the effect that loads the view.
  const [nodeColors, setNodeColors] = useState<Record<string, string>>({})

  const setNodeColor = useCallback(
    (id: string, color: string) => {
      setNodeColors((m) => {
        const next = { ...m }
        if (color) next[id] = color
        else delete next[id]
        if (activeDbRef.current) viewSet(activeDbRef.current, 'colors', next)
        return next
      })
    },
    [activeDbRef]
  )
  setColorRef.current = setNodeColor

  /** The whole map at once: the user's "reset colours" (a step), or one the undo history puts back (not). */
  const replaceColors = useCallback(
    (next: Record<string, string>) => {
      setNodeColors(next)
      if (activeDbRef.current) viewSet(activeDbRef.current, 'colors', next)
    },
    [activeDbRef]
  )

  const resetColors = useCallback(() => {
    rememberRef.current('Reset colours')
    replaceColors({})
  }, [rememberRef, replaceColors])

  // Paint a whole set of nodes at once (used by the brush box).
  const paintNodes = useCallback(
    (ids: string[], color: string) => {
      if (!ids.length) return
      rememberRef.current(color ? 'Colour processes' : 'Clear colours')
      setNodeColors((m) => {
        const next = { ...m }
        for (const id of ids) {
          if (color) next[id] = color
          else delete next[id]
        }
        if (activeDbRef.current) viewSet(activeDbRef.current, 'colors', next)
        return next
      })
    },
    [activeDbRef, rememberRef]
  )

  // Node-palette colour: when the clicked node belongs to a multi-selection, the colour
  // applies to the whole selection (delete/cleanup paths use setColorRef directly instead).
  paintSelRef.current = (id, color) => {
    const sel = selectedRef.current
    paintNodes(sel.includes(id) && sel.length > 1 ? [...sel] : [id], color)
  }

  // Reflect the colour map onto the live nodes (also covers newly reloaded nodes).
  useEffect(() => {
    colorsRef.current = nodeColors
    setNodes((ns) =>
      ns.map((n) => {
        const c = nodeColors[n.id]
        return (n.data as { color?: string }).color === c ? n : { ...n, data: { ...n.data, color: c } }
      })
    )
  }, [nodeColors, setNodes, colorsRef])

  return { nodeColors, setNodeColors, setNodeColor, replaceColors, resetColors, paintNodes }
}
