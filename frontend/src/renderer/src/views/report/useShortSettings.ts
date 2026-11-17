import { useCallback, useMemo } from 'react'
import { usePersisted } from '../../lib/persist'
import { useViewField } from '../../lib/modelView'
import { DEFAULT_SHORT_SETTINGS, type ShortSettings } from './ShortReportRail'
import { NO_SHORT_HEAD, type ShortHead } from './ShortHeadGroup'

type Variant = ShortSettings['compare'][number]
/** What belongs to the open model rather than to the app: see `useShortSettings`. */
type ModelKeys = 'compare' | 'breakdowns' | 'colour_by'
type LookSettings = Omit<ShortSettings, ModelKeys>
/** A variant as a model's view may hold it: an older view can carry a process `{ code }`, or a scenario on
 *  one, beside the scenarios. */
type StoredVariant = { scenario?: string; code?: string }

const NO_VARIANTS: StoredVariant[] = []
const NO_BREAKDOWNS: string[] = []

/** Whether the rail has a checkbox for this variant: a scenario of the reference, and nothing else. */
const isScenarioVariant = (v: StoredVariant | null | undefined): v is Variant =>
  typeof v?.scenario === 'string' && v.scenario !== '' && !v.code

/**
 * The short report's setup, from the two places it lives.
 *
 * How the report looks and what it prints — theme, colours, chapters, charts — is a preference, persisted
 * app-wide. What it is *about* belongs to the open model and lives in that model's view: the title and
 * subtitle name one study, the variants it compares are that model's own scenarios, and the tag groups it
 * breaks a contribution down by and colours the system figure by are that model's own groups.
 *
 * The variants used to be app-wide with the rest, so they travelled to the next model opened. Its rail
 * lists only its own scenarios, so the travellers had no checkbox and nobody could untick them — and every
 * render sent them along: another model's scenario applied to this one, another model's process reported
 * as one that "no longer exists in the model".
 *
 * The same holds for a process variant: the rail has no checkbox for one, so it is dropped here on
 * reading, before the rail counts it or a render sends it. The view keeps it until the next tick rewrites
 * the list.
 *
 * And for the tag groups: a breakdown chosen in one model named a group the next model does not carry, and
 * that model's report came out with one row called "untagged".
 */
export function useShortSettings(db: string | null): {
  settings: ShortSettings
  update: (patch: Partial<ShortSettings>) => void
  head: ShortHead
  setHead: (next: ShortHead) => void
} {
  const [look, setLook] = usePersisted<LookSettings>('prism.report.short.settings', DEFAULT_SHORT_SETTINGS)
  const [stored, setCompare] = useViewField<StoredVariant[]>(db, 'short_report', 'compare', NO_VARIANTS)
  const [head, setHead] = useViewField<ShortHead>(db, 'short_report', 'head', NO_SHORT_HEAD)
  const [storedDims, setBreakdowns] = useViewField<string[]>(db, 'short_report', 'breakdowns', NO_BREAKDOWNS)
  const [storedColour, setColourBy] = useViewField<string>(db, 'short_report', 'colour_by', '')
  const compare = useMemo(() => (Array.isArray(stored) ? stored.filter(isScenarioVariant) : []), [stored])
  const breakdowns = useMemo(
    () => (Array.isArray(storedDims) ? storedDims.filter((d) => typeof d === 'string') : NO_BREAKDOWNS),
    [storedDims]
  )
  const colour_by = typeof storedColour === 'string' ? storedColour : ''
  // The model's own fields last: a value persisted app-wide before they moved to the model must not win.
  const settings = useMemo(
    () => ({ ...DEFAULT_SHORT_SETTINGS, ...look, compare, breakdowns, colour_by }),
    [look, compare, breakdowns, colour_by]
  )
  const update = useCallback(
    (patch: Partial<ShortSettings>) => {
      const { compare: variants, breakdowns: dims, colour_by: colour, ...rest } = patch
      if (variants) setCompare(variants)
      if (dims) setBreakdowns(dims)
      if (colour !== undefined) setColourBy(colour)
      if (Object.keys(rest).length) {
        setLook((prev) => {
          // Written without the fields that moved to the model, so the app-wide copy stops carrying them.
          const merged: Partial<ShortSettings> = { ...DEFAULT_SHORT_SETTINGS, ...prev, ...rest }
          delete merged.compare
          delete merged.breakdowns
          delete merged.colour_by
          return merged as LookSettings
        })
      }
    },
    [setLook, setCompare, setBreakdowns, setColourBy]
  )
  return { settings, update, head, setHead }
}
