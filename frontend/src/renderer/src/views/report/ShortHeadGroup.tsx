import { AccordionGroup } from '../../components/Accordion'
import { LANGS } from '../../lib/report/model'

/** The short report's own title and subtitle. Empty means the default: the reference process as the title,
 *  and no subtitle of its own. */
export type ShortHead = { title: string; subtitle: string }
export const NO_SHORT_HEAD: ShortHead = { title: '', subtitle: '' }

/**
 * Title & language of the short report — the same group, in the same place, as the full report's.
 *
 * The title and subtitle belong to the model, not to the app: the rest of the short report's settings are
 * how you like your quick look, but a title names one study, and carried over to the next model it would
 * print one product's name on another's cover. So they live in the model's view, and the language — a
 * preference — stays with the other settings.
 *
 * The title's placeholder is the reference process, because that is what the cover prints when it is empty.
 */
export default function ShortHeadGroup({
  head,
  onHead,
  lang,
  onLang,
  refName,
  grp
}: {
  head: ShortHead
  onHead: (next: ShortHead) => void
  lang: string
  onLang: (lang: string) => void
  /** The reference process's name — the title the cover prints when none is set. */
  refName: string
  grp: { open: boolean; onToggle: () => void }
}): JSX.Element {
  const langLabel = LANGS.find((l) => l.code === lang)?.label ?? lang
  return (
    <AccordionGroup
      title="Title & language"
      summary={`${head.title.trim() || refName} · ${langLabel}`}
      {...grp}
    >
      <div className="rsec-head">
        <input
          className="rsec-name"
          value={head.title}
          aria-label="Report title"
          placeholder={refName}
          title="Printed on the cover. Left empty, the cover shows the reference process."
          onChange={(e) => onHead({ ...head, title: e.target.value })}
        />
        <input
          value={head.subtitle}
          aria-label="Report subtitle"
          placeholder="Subtitle (optional)"
          title="Printed under the title on the cover. Left empty with a title of your own, the cover shows the reference process."
          onChange={(e) => onHead({ ...head, subtitle: e.target.value })}
        />
        <select value={lang} aria-label="Report language" onChange={(e) => onLang(e.target.value)}>
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </AccordionGroup>
  )
}
