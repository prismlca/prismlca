import PrivacyLink from '../overview/PrivacyLink'
import { setAS, useAppSettings } from '../../lib/appSettings'
import {
  clampMaxTokens,
  clampMinThroughput,
  clampResearchQuestions,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_WRITER_MAX_TOKENS,
  MAX_MAX_TOKENS,
  MAX_MIN_THROUGHPUT,
  MAX_RESEARCH_QUESTIONS,
  MIN_MAX_TOKENS,
  MIN_RESEARCH_QUESTIONS
} from '../../../../shared/aiDefaults'
import { fmtInt } from '../../lib/format'
import type { ProviderChoice } from './ProviderKeyBlock'
import { NumberInput } from '../../components/NumberInput'

/** AI → Limits: how far a run may go — rounds, the provider speed preference, research width, the
 *  cost brake and both reply budgets — plus the tool-focus and approval switches and the privacy rule. */
export function AiLimitsPanel(): JSX.Element {
  // Every setting is READ from the store, never copied into local state. The copies kept showing a
  // value main had refused, missed any change made while the page was open, and made "Reset AI
  // settings" remount the page to get past them. The clamps are the ones the
  // copies applied when they were filled.
  const as = useAppSettings()
  const maxRounds = as.maxRounds
  const maxCost = as.maxCostUsd
  const maxResearch = clampResearchQuestions(as.maxResearchQuestions)
  const minTput = clampMinThroughput(as.minThroughput)
  const maxTokens = clampMaxTokens(as.maxTokens)
  const writerMaxTokens = clampMaxTokens(as.writerMaxTokens, DEFAULT_WRITER_MAX_TOKENS)
  const focusTools = as.focusTools
  const chatApproval = as.chatApproval
  // From settings.json like every other option. It used to live in localStorage alone, which meant
  // the file said `"zeroDataRetention": true` while the switch was off and main was routing without
  // the restriction — two answers to "where does my data go", and the wrong one was the readable one.
  const zdr = as.zeroDataRetention
  const zdrAnthropic = as.zdrExceptAnthropic
  const zdrOpenai = as.zdrExceptOpenai
  const zdrGoogle = as.zdrExceptGoogle
  const provider = (as.provider ?? 'openrouter') as ProviderChoice

  const setRounds = (v: string): void => {
    const n = Math.max(1, Math.min(400, Math.round(Number(v) || DEFAULT_MAX_ROUNDS)))
    setAS({ maxRounds: n })
  }
  const setThroughput = (v: string): void => {
    const n = clampMinThroughput(Number(v))
    setAS({ minThroughput: n })
  }
  const setResearchWidth = (v: string): void => {
    const n = clampResearchQuestions(Number(v))
    setAS({ maxResearchQuestions: n })
  }
  const setTokens = (v: string): void => {
    // Clamped rather than validated: an out-of-range figure is corrected to the nearest supported one
    // instead of being rejected, because the field applies immediately and there is nowhere to show
    // an error. Below the floor, legitimate long answers get cut off mid-sentence; above the ceiling,
    // a reply that has gone wrong gets expensive before anything can notice.
    const n = clampMaxTokens(Number(v))
    setAS({ maxTokens: n })
  }
  const setWriterTokens = (v: string): void => {
    // Same clamp, same reason as above; only the default differs.
    const n = clampMaxTokens(Number(v), DEFAULT_WRITER_MAX_TOKENS)
    setAS({ writerMaxTokens: n })
  }
  const setCost = (v: string): void => {
    // 0 = off; two decimals is enough for a USD ceiling.
    const n = Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100) / 100))
    setAS({ maxCostUsd: n })
  }

  return (
    <>
      <label className="settings-field">
        <span>Max tool rounds</span>
        <NumberInput min={1} max={400} value={maxRounds} onValue={setRounds} />
      </label>
      <p className="settings-hint">
        Each round can fire several tool calls — keep this high so the assistant can finish larger tasks in
        one go.
      </p>
      <label className="settings-field">
        <span>Preferred provider speed (tokens/s)</span>
        <NumberInput
          min={0}
          max={MAX_MIN_THROUGHPUT}
          step={5}
          value={minTput}
          disabled={provider === 'openai'}
          onValue={setThroughput}
        />
      </label>
      {/* Disabled rather than hidden under OpenAI: the user set this value, and hiding it would read
          as losing it. The hint says WHY it does nothing there. */}
      <p className="settings-hint">
        {provider === 'openai' ? (
          <>
            An OpenRouter routing preference — the OpenAI API is one provider with no routes to choose from.
            Your value stays stored for when you switch back.
          </>
        ) : (
          <>
            OpenRouter picks the route fresh for every request, so the same model can be four times slower
            from one message to the next. Endpoints that reach this speed are preferred; if none does, the
            request goes out as before, so a run never fails or waits for it. 0 = off.
          </>
        )}
      </p>
      <label className="settings-field">
        <span>Parallel research questions</span>
        <NumberInput
          min={MIN_RESEARCH_QUESTIONS}
          max={MAX_RESEARCH_QUESTIONS}
          value={maxResearch}
          onValue={setResearchWidth}
        />
      </label>
      <p className="settings-hint">
        How many questions one web-research call looks into at once. They run in parallel, but each is its own
        paid search — this is what research costs. Questions over the limit are reported to the assistant as
        unanswered, not dropped.
      </p>
      <label className="settings-field">
        <span>Cost limit per run ($)</span>
        <NumberInput min={0} max={100} step={0.5} value={maxCost} onValue={setCost} />
      </label>
      <p className="settings-hint">
        Safety brake: a run stops once it has spent this much and says so, in the chat or the report panel;
        chapters already written are kept. It is checked between steps, so one long reply is bounded by “Max
        tokens per reply”. 0 = off.
      </p>
      <label className="settings-field">
        <span>Max tokens per reply</span>
        <NumberInput
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          step={5000}
          value={maxTokens}
          onValue={setTokens}
        />
      </label>
      <p className="settings-hint">
        Ceiling on one reply in the chat, import matching, research and review ({fmtInt(MIN_MAX_TOKENS)}–
        {fmtInt(MAX_MAX_TOKENS)}). It stops a model that starts repeating itself — the cost limit, checked
        only between rounds, cannot. Lower is cheaper but can cut long summaries short.
      </p>
      <label className="settings-field">
        <span>Max tokens per writer reply</span>
        <NumberInput
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          step={5000}
          value={writerMaxTokens}
          onValue={setWriterTokens}
        />
      </label>
      <p className="settings-hint">
        The same ceiling for the report writer — chapters, the outline, translations. A chapter is the longest
        answer PrismLCA asks for, so this one starts higher, at {fmtInt(DEFAULT_WRITER_MAX_TOKENS)}. A chapter
        that reaches it is continued rather than cut off.
      </p>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          checked={focusTools}
          onChange={(e) => setAS({ focusTools: e.target.checked })}
        />
        <span>Offer only the tools a conversation needs (experimental)</span>
      </label>
      <p className="settings-hint">
        Smaller tool sets improve how reliably a model picks the right tool. The set is chosen once per
        conversation from what you write about, and grows if you move to another topic — reading, calculating
        and undoing are always available. Off by default until measured on your own models.
      </p>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          checked={chatApproval !== 'never'}
          onChange={(e) => {
            const next = e.target.checked ? 'irreversible' : 'never'
            setAS({ chatApproval: next })
          }}
        />
        <span>Ask me before the assistant does something that cannot be undone</span>
      </label>
      {/* Three groups, and the switch decides only the middle one. Undoable work never asks, and the three
          deletes always do: the tools ask themselves when no card did. */}
      <p className="settings-hint">
        Undoable work — process edits, exchanges, parameters, tags — runs without asking. Deleting a model, a
        custom LCIA method or a method family always asks first. This switch decides about the other steps
        that cannot be undone, renaming a model and changing a custom method or family: on, each waits for
        your OK on a card in the chat; off, they run straight away and the assistant is only told to check
        with you first.
      </p>

      <h4>Privacy</h4>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          checked={zdr}
          disabled={provider === 'openai'}
          onChange={(e) => {
            // Main holds an in-memory copy for the call sites deep inside a turn and mirrors it
            // (with provider, throughput, spellcheck) on every settings write.
            setAS({ zeroDataRetention: e.target.checked })
          }}
        />
        <span>Only use providers that keep nothing (zero data retention)</span>
      </label>
      {/* The exceptions sit under the switch, the way OpenRouter's own privacy settings arrange
          them, and they are ON by default for a measured reason: without them strict retention
          takes Fable 5.1 out of the picker on first launch — it has no zero-retention endpoint
          anywhere — and, since Google's endpoints log prompts for abuse monitoring,
          every Gemini row with it. Indented so it reads as "…except", not as more independent options. */}
      {zdr ? (
        <div className="settings-sub">
          {(
            [
              ['zdrExceptAnthropic', zdrAnthropic, 'Anthropic (Claude)'],
              ['zdrExceptOpenai', zdrOpenai, 'OpenAI (GPT)'],
              ['zdrExceptGoogle', zdrGoogle, 'Google (Gemini)']
            ] as const
          ).map(([key, value, name]) => (
            <label className="settings-field settings-check" key={key}>
              <input
                type="checkbox"
                checked={value}
                disabled={provider === 'openai'}
                onChange={(e) => setAS({ [key]: e.target.checked })}
              />
              <span>Except {name}</span>
            </label>
          ))}
        </div>
      ) : null}
      <p className="settings-hint">
        {provider === 'openai' ? (
          <>
            An OpenRouter routing rule — the OpenAI API has no per-request equivalent, so this switch has no
            effect there and PrismLCA says so rather than pretending. What holds instead: OpenAI states it
            does not train on API data by default, requests are sent without server-side storage, and data may
            be retained up to 30 days for abuse monitoring; stricter retention is an agreement between you and
            OpenAI at account level. If the per-request zero-retention guarantee matters to your data, use the
            OpenRouter provider.
          </>
        ) : (
          <>
            On = two rules at once. Every request goes only to providers that do not collect your data, which
            is also what stops them training on it; and, unless the vendor is exempted above, only to
            endpoints that retain nothing at all. Off widens the pool — some models are served solely by
            logging providers and answer “no endpoints” while this is on. The exceptions exist because
            retention is stricter than training: some models have no zero-retention endpoint anywhere — Claude
            Fable 5.1, and Gemini, whose Google endpoints keep prompts for a limited time for abuse monitoring
            — and exempting their vendor keeps them usable while everything else stays strict. An exempted
            vendor's models run under that vendor's own retention terms. Voice transcription and embeddings
            always carry the no-data-collection rule, whatever you pick here; the stricter zero-retention rule
            has no equivalent for them. Web search is a plugin and sits outside all of this.
          </>
        )}
      </p>
      <p className="settings-hint">
        Everything PrismLCA can send, to whom and when — including what stays on this computer — is in the{' '}
        <PrivacyLink plain />.
      </p>
    </>
  )
}
