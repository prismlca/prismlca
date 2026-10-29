import { useEffect, useState, type ReactNode } from 'react'
import { aiModelIssues, aiModels, removeUserModel, type AiModelInfo } from '../../lib/ai'
import { setAS, useAppSettings } from '../../lib/appSettings'
import { money } from '../../lib/money'
import { PencilIcon, TrashIcon } from '../../components/icons'
import AddModelDialog from '../AddModelDialog'
import { InfoTip } from '../../components/InfoTip'
import { EffortScale } from '../../components/EffortScale'
import { LAB_LOGOS, labKey } from '../../lib/labLogos'
import { useSortState } from '../../lib/useSortState'
import {
  AA_INDEX_VERSION,
  AA_RATINGS_PULLED,
  DEFAULT_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  OPENAI_PRICES_CHECKED
} from '../../../../shared/aiDefaults'
import type { ProviderChoice } from './ProviderKeyBlock'

/**
 * One model-role row: the picker, its explanation behind the info icon, and whatever note belongs
 * under it (a stored choice from the other provider, the reviewer's same-model consequence).
 *
 * At module level, not nested in the panel: a component redefined on every render is a new type
 * every time, so React would throw the row away and rebuild it — losing focus mid-selection.
 */
function ModelRole({
  name,
  tip,
  value,
  onPick,
  blank,
  models,
  note
}: {
  name: string
  tip: ReactNode
  value: string
  onPick: (id: string) => void
  /** The first option — what "not chosen" means for this role. `null` = no such option (the chat
   *  model always has one selected, so an empty row there would be a choice nobody can make). */
  blank: string | null
  models: AiModelInfo[]
  note?: ReactNode
}): JSX.Element {
  return (
    <>
      <label className="settings-field settings-role">
        <span className="role-name">
          {name}
          <InfoTip label={name}>{tip}</InfoTip>
        </span>
        {/* Named explicitly: the info button lives inside the <label>, and its own label would
            otherwise be folded into the field's computed name. */}
        <select aria-label={name} value={value} onChange={(e) => onPick(e.target.value)}>
          {blank !== null ? <option value="">{blank}</option> : null}
          {models
            .filter((m) => m.selectable !== false)
            .map((m) => (
              // A native <option> takes neither an icon nor a reliable tooltip, and a closed
              // select shows nothing but this text — so the provenance rides in the text itself
              // rather than in an <optgroup> label that disappears on close.
              <option key={m.id} value={m.id}>
                {/* Each part only when it has something to say: a self-added model has no
                    descriptor of ours, and "Label —  — added by you" is what naive joining gives. */}
                {[m.label, m.descriptor, m.userAdded ? 'added by you' : ''].filter(Boolean).join(' — ')}
              </option>
            ))}
        </select>
      </label>
      {note}
    </>
  )
}

/** Credited under the ratings columns — Artificial Analysis requires attribution on every tier. */
const AA_SITE = 'https://artificialanalysis.ai'

/** The price-check date as a person reads it — "30 August 2026" rather than an ISO stamp, because it
 *  is part of a sentence here and not a field.
 *
 *  `en-GB` on purpose, not the machine's locale: the sentence around it is English like every string
 *  in this product, and the machine's locale put a German "30. August 2026" in the middle of it. */
function priceDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
}

type ModelSortKey = 'lab' | 'label' | 'temperature' | 'input' | 'output' | 'intelligence' | 'agentic'
/** AI → Models: the model of each job, the chat model’s thinking dial, and the catalogue table with
 *  prices and ratings — the only AI page that needs the catalogue, so the only one that loads it. */
export function AiModelsPanel(): JSX.Element {
  const [models, setModels] = useState<AiModelInfo[]>([])
  // Read from the store, never copied — see AiLimitsPanel.
  const as = useAppSettings()
  const model = as.model
  // '' = follow the chat model, which is what almost everyone wants and what this used to do silently.
  const writerModel = as.writerModel
  // '' = each sub-agent keeps its own cheap default (see subagent.ts). Separate settings, because
  // the jobs reward different things — see the hints under the fields. The context summariser has
  // none: it writes what the chat model then works from, so the chat model writes it.
  const researchModel = as.researchModel
  const reviewModel = as.reviewModel
  const matchModel = as.matchModel
  // Per model id: '' / absent = the API's default. Read live, so a model switch shows that model's choice.
  const efforts = as.reasoningEffort ?? {}
  // The note under the table says whether the privacy rule covers self-added models.
  const zdr = as.zeroDataRetention
  // Column sort for the info table: click a header → asc → desc → back to catalog order.
  const { sort, sortClick, sortMark: mark } = useSortState<ModelSortKey>()

  const [modelIssues, setModelIssues] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    void aiModels()
      .then(setModels)
      .catch(() => {})
    void aiModelIssues()
      .then(setModelIssues)
      .catch(() => {})
  }, [])

  // Only the ACTIVE provider's catalogue is offered and listed — a mixed table would compare live
  // OpenRouter prices with OpenAI's hand-maintained list prices as if they were the same number.
  const provider = (as.provider ?? 'openrouter') as ProviderChoice
  const providerModels = models.filter((m) => (m.provider ?? 'openrouter') === provider)

  // A stored choice from the OTHER provider is not rewritten — the picker falls back to its
  // "Default (…)" row, and main resolves it the same way, so display and behaviour agree by
  // construction. It used to say so in a paragraph under every one of the six rows; the row itself
  // already names the model that applies, and six of those paragraphs said it six times.
  const inCatalogue = (id: string): boolean => providerModels.some((m) => m.id === id)
  const foreign = (id: string): boolean => models.length > 0 && !!id && !inCatalogue(id)
  const shownValue = (id: string): string => (id && inCatalogue(id) ? id : '')
  const defaultChatId = provider === 'openai' ? DEFAULT_OPENAI_MODEL_ID : DEFAULT_MODEL_ID
  const sortVal = (m: AiModelInfo, key: ModelSortKey): string | number | null => {
    if (key === 'lab') return labKey(m.id)
    if (key === 'label') return m.label
    if (key === 'input') return m.pricing?.input ?? null
    if (key === 'output') return m.pricing?.output ?? null
    return m[key]
  }
  // Self-added rows of the ACTIVE provider — they are what the consequence note below the table
  // is about, so a note must not appear for models the current provider cannot even reach.
  const ownModels = providerModels.filter((m) => m.userAdded)

  const shownModels = sort
    ? [...providerModels].sort((a, b) => {
        const va = sortVal(a, sort.key)
        const vb = sortVal(b, sort.key)
        if (va == null && vb == null) return 0
        if (va == null) return 1 // missing values (e.g. Whisper's ratings) always sink to the end
        if (vb == null) return -1
        const cmp = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number)
        return cmp * sort.dir
      })
    : providerModels

  const pickModel = (id: string): void => {
    setAS({ model: id })
  }
  const pickWriterModel = (id: string): void => {
    setAS({ writerModel: id })
  }
  const pickResearchModel = (id: string): void => {
    setAS({ researchModel: id })
  }
  const pickReviewModel = (id: string): void => {
    setAS({ reviewModel: id })
  }
  const pickMatchModel = (id: string): void => {
    setAS({ matchModel: id })
  }

  return (
    <>
      <h4>Model</h4>
      {/* Six roles, six pickers, and each of them earns its explanation — but stacked as paragraphs
          they buried the pickers themselves. The text is unchanged, it moved into the info icon
          beside the role name. */}
      <ModelRole
        name="Chat model"
        tip="The assistant on the canvas — building the model, searching, calculating, tagging."
        value={shownValue(model) || (inCatalogue(model) ? model : '')}
        onPick={(id) => id && pickModel(id)}
        blank={
          foreign(model)
            ? `Default (${providerModels.find((m) => m.id === defaultChatId)?.label ?? defaultChatId})`
            : null
        }
        models={providerModels}
      />
      {/* The thinking dial of the chat model, per model. The catalogue's ratings were measured at each
          model's TOP effort while the request sent none — so what you got was the API default, for
          several models far below the row. Offered only where the vendor documents the levels: an
          unsupported level is a 400 that costs a run (the loop then falls back to the default once). */}
      {(() => {
        const current = providerModels.find((m) => m.id === (shownValue(model) || defaultChatId))
        const levels = current?.reasoningEfforts ?? []
        const chosen = efforts[current?.id ?? ''] ?? ''
        return (
          <>
            <label className="settings-field settings-role">
              <span className="role-name">
                Reasoning effort
                <InfoTip label="Reasoning effort">
                  How hard the chat model thinks before it writes. “Default” sends nothing and leaves the
                  model on its API&rsquo;s own setting — for several models that is far below their best. The
                  levels offered are the ones the vendor documents for this model; stored per model, so
                  switching models keeps each one&rsquo;s choice. If the model&rsquo;s API rejects a level,
                  the run continues on the default and says so.
                </InfoTip>
              </span>
              <EffortScale
                label="Reasoning effort"
                levels={levels}
                value={chosen}
                onChange={(v) => {
                  if (!current) return
                  const next = { ...efforts }
                  if (v) next[current.id] = v
                  else delete next[current.id]
                  setAS({ reasoningEffort: next })
                }}
              />
            </label>
          </>
        )
      })()}
      {/* The chat model and its dial above the line, the other jobs' models below it: the dial belongs
          to the chat model alone. */}
      <hr className="settings-dashed" />
      {/* Two models, because the two jobs reward different things. Tool work is mechanical and long: a
          cheap model does it well and the round count makes the price. A chapter goes to a client and is
          read by a person. This used to be one setting, and the hint above it even claimed it applied
          only to the chat — so anyone who moved the chat to a cheap model was writing their client's
          report with it and had no way to know. */}
      <ModelRole
        name="Report writing model"
        tip="Writes and updates the report chapters and the glossary. Worth a better model than the chat: tool work is long and mechanical, a chapter is read by your client."
        value={shownValue(writerModel)}
        onPick={pickWriterModel}
        blank="Same as the chat model"
        models={providerModels}
      />
      {/* Three helpers, three settings. They used to be one setting, and the summariser was not
          settable at all — which made it the only model in the app you could not choose, on a job
          that rewrites material the assistant then works from. Named here because they are
          otherwise invisible: each bills under its OWN model in the cost table, so a run on one
          model quietly showed a second one's name and nobody could tell why. */}
      <ModelRole
        name="Research model"
        tip={
          <>
            Runs <code>research_web</code> and <code>research_bom</code> in isolation: no access to your
            model, web search only, one parallel leg per question. Wants a cheap model that searches well
            rather than a clever one — each leg is a separate paid request, and web search costs about{' '}
            {provider === 'openai' ? '$0.01' : '$0.005'} per search.
          </>
        }
        value={shownValue(researchModel)}
        onPick={pickResearchModel}
        blank="Default (a cheap model with web search)"
        models={providerModels}
      />
      <ModelRole
        name="Review model"
        tip={
          <>
            Reads the critical-review dossier and argues against the study, and reads every report chapter the
            writer drafts before it is stored. Its value is that it is a <em>second</em> opinion: on one
            practice run the reviewer caught a wrong background dataset that the model which had chosen it
            kept overlooking, and on another it found a binder that was really a paint.
          </>
        }
        value={shownValue(reviewModel)}
        onPick={pickReviewModel}
        blank="Default (a cheap model, different from the chat)"
        models={providerModels}
        note={
          <>
            {/* Not a warning, a fact: choosing the chat model here is allowed and sometimes deliberate
                (one strong model, one bill). It just stops being a second opinion, and that is the whole
                reason the reviewer exists — so it stays on the page, not in the hover panel: a
                consequence you have already caused is not an explanation you go looking for. */}
            <p className="settings-hint">
              The review model also reads every drafted report chapter as it will print, against the figures
              and the study, and settles its points with the writer — you only hear about what the two could
              not settle.
            </p>
            {reviewModel && reviewModel === model ? (
              <p className="settings-hint warn">
                This is the same model that builds the study. It will review its own work — a reviewer usually
                agrees with itself, so expect fewer findings than a different model would raise.
              </p>
            ) : null}
          </>
        }
      />
      <ModelRole
        name="Material assignment model"
        tip="Places the flows of an imported database — from SimaPro, openLCA, GaBi or an ILCD package — onto PrismLCA's own vocabulary. It only ever chooses from a shortlist the import has already found, and it may always answer “none of these”: an unmatched flow is reported, a wrongly matched one becomes a number that looks finished. Bulk work with one short answer per flow, so a cheap model is the right answer here."
        value={shownValue(matchModel)}
        onPick={pickMatchModel}
        blank="Default (GPT-6 Luna)"
        models={providerModels}
      />
      <h4>Cost &amp; performance</h4>
      <div className="ai-table-wrap">
        <table className="ai-table">
          <thead>
            <tr>
              <th className="th-sortable" onClick={() => sortClick('lab')}>
                Lab{mark('lab')}
              </th>
              <th className="th-sortable" onClick={() => sortClick('label')}>
                Model{mark('label')}
              </th>
              <th className="num th-sortable" onClick={() => sortClick('temperature')}>
                Temp{mark('temperature')}
              </th>
              {/* The asterisk is the whole point of the note under the table: the two price
                  columns come from somewhere different per provider, and a number whose origin is
                  invisible reads as equally firm either way. */}
              <th className="num th-sortable" onClick={() => sortClick('input')}>
                Input $/1M<sup>*</sup>
                {mark('input')}
              </th>
              <th className="num th-sortable" onClick={() => sortClick('output')}>
                Output $/1M<sup>*</sup>
                {mark('output')}
              </th>
              {/* Same idea as the asterisk: the dagger carries the attribution Artificial Analysis
                  requires, and the index version — a score is only comparable within one. */}
              <th className="num th-sortable" onClick={() => sortClick('intelligence')}>
                Intel.<sup>†</sup>
                {mark('intelligence')}
              </th>
              <th className="num th-sortable" onClick={() => sortClick('agentic')}>
                Agentic<sup>†</sup>
                {mark('agentic')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shownModels.map((m) => (
              <tr key={m.id} className={m.id === model ? 'on' : undefined}>
                <td className="lab" title={labKey(m.id)}>
                  {LAB_LOGOS[labKey(m.id)] ? (
                    <img className="cost-logo" src={LAB_LOGOS[labKey(m.id)]} alt={labKey(m.id)} />
                  ) : (
                    labKey(m.id)
                  )}
                </td>
                <td title={m.id}>
                  {m.label}
                  {m.userAdded ? (
                    // A native title, not the InfoTip used for the role fields: this cell sits
                    // inside .ai-table-wrap (overflow-x: auto), which clips vertical overflow too —
                    // and self-added rows are at the BOTTOM, so a panel opening downward would be
                    // cut off. The table already explains its other cells this way.
                    <>
                      <span
                        className="model-own"
                        title="Added by you — from models.json in your user folder. Not checked or rated by PrismLCA."
                        aria-label="Added by you"
                      >
                        <PencilIcon />
                      </span>
                      {/* Removal belongs on the row, not in the dialog: the dialog is where you
                          look for a model you do NOT have yet. */}
                      <button
                        className="model-own model-drop"
                        title={`Remove ${m.label} from your list`}
                        aria-label={`Remove ${m.label}`}
                        onClick={() => {
                          void removeUserModel(m.id).then(() => {
                            void aiModels().then(setModels)
                            void aiModelIssues().then(setModelIssues)
                          })
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  ) : null}
                </td>
                <td
                  className="num"
                  title={
                    m.temperature == null
                      ? 'Vendor default — the parameter is not sent (removed/optimised by the vendor)'
                      : m.userAdded
                        ? 'From your own models.json'
                        : 'Researched per-model recommendation'
                  }
                >
                  {m.temperature ?? 'default'}
                </td>
                <td className="num">{money(m.pricing?.input)}</td>
                <td className="num">{money(m.pricing?.output)}</td>
                <td className="num">{m.intelligence ?? '–'}</td>
                <td className="num">{m.agentic ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* One line each. The reader needs the origin and, where it is hand-kept, the date — the rest
          was explanation nobody had asked for. */}
      {provider === 'openai' ? (
        <p className="settings-hint">
          <b>*</b> Kept by hand — OpenAI has no pricing API. As of <b>{priceDate(OPENAI_PRICES_CHECKED)}</b>;
          its costs are estimates.
        </p>
      ) : (
        <p className="settings-hint">
          <b>*</b> Live from OpenRouter's API, cached an hour; run costs are OpenRouter's own.
        </p>
      )}
      {provider === 'openrouter' ? (
        <div className="addmodel-bar">
          <button className="btn sm" onClick={() => setAddOpen(true)}>
            Add model…
          </button>
          <span className="settings-hint">
            New models appear at OpenRouter before they appear in a PrismLCA release.
          </span>
        </div>
      ) : null}
      {addOpen ? (
        <AddModelDialog
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            // Re-read both: the catalogue gained a row, and the file may have refused something.
            void aiModels().then(setModels)
            void aiModelIssues().then(setModelIssues)
          }}
        />
      ) : null}
      {ownModels.length ? (
        // The row mark says WHERE a model came from; this says what that means for it. Not a
        // warning about licensed data — the privacy rule above is what
        // actually governs where a prompt may go, and it enforces both halves:
        // no collection (so no training) and, unless the vendor is exempted, no retention.
        <p className="settings-hint">
          <b>{ownModels.length}</b> {ownModels.length === 1 ? 'model comes' : 'models come'} from your own{' '}
          <code>models.json</code>. PrismLCA has not checked {ownModels.length === 1 ? 'it' : 'them'}, but the
          privacy rule above applies to {ownModels.length === 1 ? 'it' : 'them'} like any other model:{' '}
          {zdr
            ? 'requests go only to providers that do not collect your data — which is what stops them training on it — and, unless you exempted the vendor, only to endpoints that keep nothing.'
            : 'it is switched off at the moment, so nothing restricts which provider serves them.'}{' '}
          Price and spending limit work as usual.
        </p>
      ) : null}
      {modelIssues.length ? (
        // Loud enough to find, quiet enough not to alarm. Silence here would be the worst outcome:
        // someone edits models.json, the model does not appear, and nothing says why.
        <p className="settings-hint warn">
          <b>models.json:</b> {modelIssues.length} {modelIssues.length === 1 ? 'entry was' : 'entries were'}{' '}
          not loaded.
          <br />
          {modelIssues.map((issue, i) => (
            <span key={i}>
              {issue.replace(/^models\.json: /, '')}
              <br />
            </span>
          ))}
        </p>
      ) : null}
      <p className="settings-hint">
        <b>†</b> Intelligence Index v{AA_INDEX_VERSION} and Agentic Index by{' '}
        <a
          href={AA_SITE}
          onClick={(e) => {
            e.preventDefault()
            void window.prism.openExternal(AA_SITE)
          }}
        >
          Artificial Analysis
        </a>
        , read {priceDate(AA_RATINGS_PULLED)}. Scores compare within one index version, and always at the
        model's highest reasoning effort — PrismLCA sends none, so the provider default may sit well below. A
        dash means unrated there, not zero.
      </p>
    </>
  )
}
