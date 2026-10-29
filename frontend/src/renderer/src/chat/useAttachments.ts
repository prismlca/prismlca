import { useCallback, useState } from 'react'
import { aiAttach, attachDropped, droppedFilePaths, pickFiles, type AttachmentMeta } from '../lib/ai'
import { errMsg } from '../lib/errors'

/** What the attach button offers. The main process enforces the real limits per kind, and the
 *  backend refuses anything it cannot convert — this list only saves the user a rejected pick. */
const ATTACH_FILTERS = [
  {
    name: 'Documents, spreadsheets, images',
    extensions: [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'gif',
      'xlsx',
      'xlsm',
      'docx',
      'html',
      'htm',
      'txt',
      'md',
      'markdown',
      'csv',
      'tsv',
      'json',
      'xml',
      'yaml',
      'yml',
      'log',
      'rst',
      'ini',
      'cfg',
      'toml'
    ]
  }
]

export interface Attachments {
  attachments: AttachmentMeta[]
  attaching: boolean
  /** The dialog route ("Attach files" in the "+" menu). */
  onAttachClick: () => Promise<void>
  /** Files dropped onto the chat; false when the drop carried no files (a dataset, say). */
  onFileDrop: (e: React.DragEvent) => boolean
  removeAttachment: (index: number) => void
  /** Empties the tray, or with `only` removes just those entries (the ones a send took along). */
  clearAttachments: (only?: readonly AttachmentMeta[]) => void
}

/**
 * The files attached to the message being written.
 *
 * Not per chat: the chips belong to the message in the box, and only a send or the chip's ✕ clears
 * them. `setError` and `setOpen` are the panel's own state setters (stable identities).
 */
export function useAttachments({
  setError,
  setOpen
}: {
  setError: (message: string | null) => void
  setOpen: (open: boolean) => void
}): Attachments {
  // Files attached to the message being written. Descriptions only: the files are already stored
  // with the project by the time they land here, so this survives nothing being sent and costs
  // nothing to hold. An entry with `error` set is one that was refused and stays visible until the
  // user removes it — dropping it silently is how you end up sending four of five files.
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [attaching, setAttaching] = useState(false)

  /** Run an attach — the main process reads the files and has the backend store them — and merge
   *  its outcome into the chips. */
  const attachWith = useCallback(
    async (load: () => Promise<AttachmentMeta[]>) => {
      setAttaching(true)
      setOpen(true)
      try {
        const added = await load()
        setAttachments((prev) => {
          // Same file twice is the same attachment (the id is its content hash), so re-attaching it
          // updates the entry instead of stacking a duplicate the model would then read twice.
          const byId = new Map(prev.filter((a) => a.id).map((a) => [a.id, a]))
          const failed = prev.filter((a) => !a.id)
          for (const a of added) if (a.id) byId.set(a.id, a)
          return [...byId.values(), ...failed, ...added.filter((a) => !a.id)]
        })
        setError(null)
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setAttaching(false)
      }
    },
    [setError, setOpen]
  )

  const onAttachClick = useCallback(async () => {
    const paths = (await pickFiles(ATTACH_FILTERS).catch(() => [] as string[])).filter(Boolean)
    if (paths.length) await attachWith(() => aiAttach(paths))
  }, [attachWith])

  /** Files dropped onto the chat. The renderer cannot read a dropped File's path itself any more,
   *  so the preload resolves it (and grants main the one read `aiAttach` needs); anything that
   *  resolves to nothing (a dragged browser image, say) is skipped rather than half-attached. */
  const onFileDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return false
      e.preventDefault()
      void droppedFilePaths(files)
        .catch(() => ({ paths: [] as string[], overflow: 0 }))
        .then((d) => (d.paths.length || d.overflow ? attachWith(() => attachDropped(d)) : undefined))
      return true
    },
    [attachWith]
  )

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, j) => j !== index))
  }, [])
  const clearAttachments = useCallback((only?: readonly AttachmentMeta[]) => {
    setAttachments((prev) =>
      only ? prev.filter((a) => !only.some((o) => o === a || (!!o.id && o.id === a.id))) : []
    )
  }, [])

  return { attachments, attaching, onAttachClick, onFileDrop, removeAttachment, clearAttachments }
}
