import { useCallback, useMemo } from 'react'
import { usePersisted } from '../../lib/persist'
import { useViewField } from '../../lib/modelView'
import { DEFAULT_SHORT_SETTINGS, type ShortSettings } from './ShortReportRail'
import { NO_SHORT_HEAD, type ShortHead } from './ShortHeadGroup'

type Variant = ShortSettings['compare'][number]
type LookSettings = Omit<ShortSettings, 'compare'>
/** A variant as a model's view may hold it: an older view can carry a process `{ code }`, or a scenario on
 *  one, beside the scenarios. */
type StoredVariant = { scenario?: string; code?: string }

const NO_VARIANTS: StoredVariant[] = []

/** Whether the rail has a checkbox for this variant: a scenario of the reference, and nothing else. */
const isScenarioVariant = (v: StoredVariant | null | undefined): v is Variant =>
  typeof v?.scenario === 'string' && v.scenario !== '' && !v.code

/**
 * The short report's setup, from the two places it lives.
 *
 * How the report looks and what it prints — theme, colours, chapters, charts — is a preference, persisted
 * app-wide. What it is *about* belongs to the open model and lives in that model's view: the title and
 * subtitle name one study, and the variants it compares are that model's own scenarios.
 *
 * The variants used to be app-wide with the rest, so they travelled to the next model opened. Its rail
 * lists only its own scenarios, so the travellers had no checkbox and nobody could untick them — and every
 * render sent them along: another model's scenario applied to this one, another model's process reported
 * as one that "no longer exists in the model".
 *
 * The same holds for a process variant: the rail has no checkbox for one, so it is dropped here on
 * reading, before the rail counts it or a render sends it. The view keeps it until the next tick rewrites
 * the list.
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
  const compare = useMemo(() => (Array.isArray(stored) ? stored.filter(isScenarioVariant) : []), [stored])
  // `compare` last: a value persisted before the variants moved to the model must not win over them.
  const settings = useMemo(() => ({ ...DEFAULT_SHORT_SETTINGS, ...look, compare }), [look, compare])
  const update = useCallback(
    (patch: Partial<ShortSettings>) => {
      const { compare: variants, ...rest } = patch
      if (variants) setCompare(variants)
      if (Object.keys(rest).length) {
        setLook((prev) => {
          // Written without its old `compare`, so the app-wide copy stops carrying one.
          const { compare: _gone, ...kept } = { ...DEFAULT_SHORT_SETTINGS, ...prev, ...rest }
          return kept
        })
      }
    },
    [setLook, setCompare]
  )
  return { settings, update, head, setHead }
}
