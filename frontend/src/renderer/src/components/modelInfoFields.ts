/**
 * The study form's field catalogue: which study-metadata fields Model info asks for, in which ISO 14044
 * section, with the label, the hint and the input each one gets. The backend's list of fields is
 * `engine/study.py` FIELDS; the ones a report must state are `REPORTABLE_SCOPE` in `lib/report/model.ts`.
 */
export interface Field {
  key: string
  label: string
  /** Multi-line, and grown to its content — a scope is two sentences or ten. */
  textarea?: boolean
  placeholder?: string
  /** ISO asks for it; the report says "not defined" without it, and a review starts here. */
  required?: boolean
  /** Half-width in the two-column grid. Long prose takes the full width. */
  half?: boolean
  /** A closed choice renders as a select — the study language, not free prose. */
  options?: Array<{ code: string; label: string }>
  /** What an empty stored value means, shown as the selected option (e.g. 'en'). */
  fallback?: string
  /** Hover text for fields that need a why. */
  title?: string
}

/**
 * The study metadata, grouped the way ISO 14044 groups it.
 *
 * It used to be one flat column of thirteen fields, which gave no sense of what was still missing —
 * and this is the one dialog whose emptiness has consequences: the report chapters and the assistant's
 * brief are both written from these fields, so a blank one becomes "not defined" in a client document.
 * The clause per section is printed because it is the answer to "why is it asking me this".
 */
export const SECTIONS: Array<{ id: string; title: string; std: string; fields: Field[] }> = [
  {
    id: 'goal',
    title: 'Goal & scope',
    std: 'ISO 14044 §4.2.2',
    fields: [
      {
        key: 'language',
        label: 'Study language',
        half: true,
        // The language the study is DOCUMENTED in — process notes, scenario names, these fields.
        // The assistant is instructed to honour it, and a report in another language translates
        // from it mechanically; mixed documentation becomes a mixed-language document.
        options: [
          { code: 'en', label: 'English' },
          { code: 'de', label: 'Deutsch' },
          { code: 'fr', label: 'Français' },
          { code: 'es', label: 'Español' },
          { code: 'pt', label: 'Português' }
        ],
        fallback: 'en',
        title:
          'The language the study is documented in — process notes, scenario names, these fields. The assistant writes documentation in it; a report in another language translates from it.'
      },
      {
        key: 'goal',
        label: 'Goal',
        textarea: true,
        required: true,
        placeholder: 'Why the study is done, for whom, and which decision it supports'
      },
      {
        key: 'scope',
        label: 'Scope',
        textarea: true,
        placeholder: 'What the study covers and what it deliberately leaves out'
      }
    ]
  },
  {
    id: 'object',
    title: 'Object of study',
    std: 'ISO 14044 §4.2.3',
    fields: [
      {
        key: 'functional_unit',
        label: 'Functional unit',
        required: true,
        placeholder: 'e.g. 1 kg of bread, at bakery gate'
      },
      {
        // The market the datasets have to match. Nothing else in the study says it, and the language
        // of the conversation is no answer: a German-speaking author may assess a product sold in Brazil.
        key: 'geography',
        label: 'Geography',
        half: true,
        placeholder: 'e.g. made in Poland, sold in Germany',
        title:
          'Where the product is made and where it is sold or used. The datasets are chosen to match it, so the assistant asks for it when it is empty.'
      },
      {
        key: 'reference_year',
        label: 'Reference year',
        half: true,
        placeholder: 'e.g. 2025',
        title: 'The year or period the data should represent.'
      },
      {
        key: 'system_boundaries',
        label: 'System boundaries',
        textarea: true,
        required: true,
        placeholder: 'e.g. cradle-to-gate; excluded: capital goods, use phase'
      }
    ]
  },
  {
    id: 'rules',
    title: 'Rules & allocation',
    std: 'ISO 14044 §4.3.3–4.3.4',
    fields: [
      {
        key: 'cutoff_criteria',
        label: 'Cut-off criteria',
        placeholder: 'e.g. 1 % by mass, 1 % by GWP, 5 % per stage'
      },
      {
        key: 'allocation',
        label: 'Process allocation',
        textarea: true,
        half: true,
        placeholder: 'How a multi-output process is split — mass, economic, energy'
      },
      {
        key: 'system_allocation',
        label: 'System allocation (end of life)',
        textarea: true,
        half: true,
        placeholder: 'Cut-off, avoided burden, 50/50 — and why'
      }
    ]
  },
  {
    id: 'who',
    title: 'Who and when',
    // The review fields carry the clause that makes them matter: a published comparative assertion
    // without a critical review has to say so, and only the answer here can say that it does not have
    // to. The description beside it cannot — its honest content is usually a negation.
    std: 'ISO 14044 §7.3.3',
    fields: [
      { key: 'author', label: 'Author(s)', half: true, placeholder: 'Who wrote the study' },
      { key: 'organisation', label: 'Carried out by', half: true, placeholder: 'Your organisation' },
      { key: 'commissioner', label: 'Commissioner', half: true, placeholder: 'Who it was carried out for' },
      { key: 'date', label: 'Date', half: true, placeholder: 'e.g. 2026-07' },
      {
        // A closed choice rather than a reading of the text beside it: "was there a critical review?"
        // is a yes/no, and the sentence authors write into the description is nearly always a
        // negation ("no critical review — internal screening study"). Reading that as a yes switched
        // off the very ISO 14044 §7.3.3 note it described. Unanswered counts as "not confirmed", so
        // the note is printed until somebody states otherwise.
        key: 'critical_review_done',
        label: 'Critical review carried out?',
        half: true,
        options: [
          { code: '', label: 'Not recorded' },
          { code: 'no', label: 'No — none was carried out' },
          { code: 'yes', label: 'Yes — a critical review was carried out' }
        ],
        title:
          'Whether a critical review under ISO 14044 §7 actually took place. A report that compares variants and is intended for disclosure to the public has to state a missing review, and only "Yes" removes that statement — the description beside this can name a review, it cannot confirm one.'
      },
      {
        key: 'critical_review',
        label: 'Critical review — who, when, what form',
        placeholder: 'e.g. panel review by three interested parties, June 2026 — or why there was none'
      },
      {
        key: 'notes',
        label: 'Notes',
        textarea: true,
        placeholder: 'Anything a reader should know before the results'
      }
    ]
  }
]

export const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields)
