import { AccordionGroup } from '../../components/Accordion'
import Busy from '../../components/Busy'
import { LANGS, type StoredReportFull } from '../../lib/report/model'

/** Title, subtitle, language, the disclosure flag and the study-text translation — the head of the
 * document (the group id stays `document`, it is what "which group is
 * open" is remembered under). */
export default function ReportHeadGroup({
  report,
  grp,
  writing,
  runActive,
  translateNote,
  langHint,
  onDraft,
  mutate,
  base,
  onTranslate
}: {
  report: StoredReportFull
  grp: { open: boolean; onToggle: () => void }
  writing: string | null
  runActive: boolean
  translateNote: string | null
  /** languagePlan's hint — null when study and report speak the same language. */
  langHint: string | null
  /** Optimistic local edit while typing; the blur posts through `mutate`. */
  onDraft: (patch: Partial<StoredReportFull>) => void
  mutate: (
    method: string,
    path: string,
    body?: object | ((current: StoredReportFull | null) => object | null)
  ) => Promise<boolean>
  base: string
  onTranslate: () => void
}): JSX.Element {
  return (
    <AccordionGroup
      // "Title & language" rather than "Document": every group here is about the document, so the
      // word said nothing — and this one holds exactly the two things a reader of the head wants confirmed.
      // The group's *id* stays `document`, because it is what "which group is open" is remembered under.
      title="Title & language"
      summary={`${report.name} · ${LANGS.find((l) => l.code === report.lang)?.label ?? report.lang}`}
      {...grp}
    >
      <div className="rsec-head">
        <input
          className="rsec-name"
          value={report.name}
          aria-label="Report name"
          onChange={(e) => onDraft({ name: e.target.value })}
          onBlur={() => void mutate('POST', base, { name: report.name })}
        />
        <input
          value={report.subtitle ?? ''}
          aria-label="Report subtitle"
          placeholder="Subtitle (optional)"
          title="Printed under the title on the cover. Left empty, the cover shows the reference process."
          onChange={(e) => onDraft({ subtitle: e.target.value })}
          onBlur={() => void mutate('POST', base, { subtitle: report.subtitle })}
        />
        <select
          value={report.lang}
          aria-label="Report language"
          onChange={(e) => void mutate('POST', base, { lang: e.target.value })}
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      {/* Marking a report for publication is not cosmetic: a comparative assertion disclosed to the
            public requires a critical review under ISO 14044 §7.3.3, and if none is recorded on the study
            the report has to say so. That note is added outside the chapter list, so it cannot be dropped
            by deleting a chapter. */}
      <label className="rsec-public">
        <input
          type="checkbox"
          checked={Boolean(report.options?.intended_public)}
          onChange={(e) => {
            // Captured before the queue runs: a function payload is evaluated after React has
            // reverted this controlled box, so reading `e.target.checked` in there posted the
            // state we were trying to leave — the box could never be ticked.
            const next = e.target.checked
            void mutate('POST', base, (r) => ({
              options: { ...(r?.options ?? {}), intended_public: next }
            }))
          }}
        />
        Intended for disclosure to the public
        <em>
          {' '}
          — with more than one subject this adds the ISO 14044 §7.3.3 note unless a critical review is
          recorded in the model info.
        </em>
      </label>
      {/* The study's own words follow the model, not the report: a German model in an English
            report printed half its inventory chapter in German (V123). Translation is an explicit
            button, not a render-time automatism — the words in a deliverable are the author's to
            approve, and the first collection may compute the report data (tens of seconds). */}
      <div className="rsec-translate">
        <button
          className="btn sm"
          disabled={writing !== null || runActive}
          title="Translate the study's own texts — process notes, scenario names, limitations, the functional unit — into the report language. Collected deterministically, translated by the writer model, stored on this report; the model texts themselves stay untouched."
          onClick={onTranslate}
        >
          {writing === 'translations' ? <Busy label="Translating" /> : 'Translate study texts'}
        </button>
        {translateNote ? <span className="settings-hint">{translateNote}</span> : null}
        {!translateNote && langHint ? <span className="settings-hint">{langHint}</span> : null}
      </div>
    </AccordionGroup>
  )
}
