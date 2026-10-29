import { bgChipClass, shortDbLabel } from '../lib/search'

/**
 * Whose dataset this is: the user's own library (yellow, its name) or one of the background databases
 * (ecoinvent navy, BAFU violet; short label — "ecoinvent 3.12", "BAFU 2026" — full name in the tooltip). The same
 * chips as the search results, so a name learnt there is recognised in the inspector and the details
 * window. Sits in the eyebrow line, right after its word. A model's own foreground
 * process carries none — it belongs to the model itself.
 */
export default function SourceChip({
  database,
  kind
}: {
  database: string
  kind?: string
}): JSX.Element | null {
  if (kind === 'library') return <span className="chip lib">{database}</span>
  if (kind === 'background')
    return (
      <span className={bgChipClass(database)} title={database}>
        {shortDbLabel(database)}
      </span>
    )
  return null
}
