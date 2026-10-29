import { Fragment, useState } from 'react'
import { DEFAULT_SETTINGS, getSettings, setSettings, useSettings, type PrismSettings } from '../lib/settings'
import { ZDR_KEY } from '../lib/ai'
import { IdentityFields } from './CoverSettings'
import TransportPanel, { resetTransport, type TransportTab } from './TransportSettings'
import PreferredBackgroundField from './PreferredBackground'
import ExternalAgentsSettings from './ExternalAgentsSettings'
import { setAS, useAppSettings, useAppSettingsWriteError } from '../lib/appSettings'
import { SPELLCHECK_CHOICES } from '../../../shared/spellcheck'
import {
  GearIcon,
  GlobeIcon,
  InfoIcon,
  ModelIcon,
  ReportIcon,
  SparkleIcon,
  TruckIcon
} from '../components/icons'
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_RESEARCH_QUESTIONS,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_THROUGHPUT,
  DEFAULT_WRITER_MAX_TOKENS,
  DEFAULT_MODEL_ID,
  DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  DEFAULT_ZDR_EXCEPT_GOOGLE,
  DEFAULT_ZDR_EXCEPT_OPENAI,
  DEFAULT_ZERO_DATA_RETENTION
} from '../../../shared/aiDefaults'
import EscapeCloser from '../components/EscapeCloser'
import { AiProviderPanel } from './settings/AiProviderPanel'
import { AiModelsPanel } from './settings/AiModelsPanel'
import { AiLimitsPanel } from './settings/AiLimitsPanel'
import { AiChatPanel } from './settings/AiChatPanel'
import { SkillsPanel } from './settings/SkillsPanel'
import { ToolsPanel } from './settings/ToolsPanel'
import { CostsPanel } from './settings/CostsPanel'
import { AboutPanel } from './settings/AboutPanel'
import { KeepAwakeFields } from './settings/KeepAwakeFields'
import { NumberInput } from '../components/NumberInput'

/** Somewhere on a page to land on, beyond the page itself. */
export type SettingsFocus = 'add-skill'
/** Settings window: a category list on the left, the selected panel on the right.
 * Categories with a `group` render under one shared heading (e.g. all AI pages) instead of
 * repeating the group name in every label. */
export type SettingsCategory =
  | 'display'
  | 'language'
  | 'modelling'
  | 'reporting'
  | 'transport-keys'
  | 'transport-adjustments'
  | 'transport-limits'
  | 'transport-costs'
  | 'ai-provider'
  | 'ai-models'
  | 'ai-limits'
  | 'ai-chat'
  | 'ai-skills'
  | 'ai-tools'
  | 'ai-mcp'
  | 'ai-costs'
  | 'about'
type Category = SettingsCategory
// The key stays `display` (identifiers are not renamed); the page is "General" because it holds
// more than display settings. Language has its own page.
const CATEGORIES: { key: Category; label: string; group?: string; icon?: () => JSX.Element }[] = [
  { key: 'display', label: 'General', icon: GearIcon },
  { key: 'language', label: 'Language', icon: GlobeIcon },
  { key: 'modelling', label: 'Modelling', icon: ModelIcon },
  { key: 'reporting', label: 'Reporting', icon: ReportIcon },
  // Not an AI page: the Distances button in the toolbar uses the same keys and limits with the
  // assistant switched off, and its costs are a table of their own.
  { key: 'transport-keys', label: 'API provider', group: 'Transport distances' },
  { key: 'transport-adjustments', label: 'DAF', group: 'Transport distances' },
  { key: 'transport-limits', label: 'Limits', group: 'Transport distances' },
  { key: 'transport-costs', label: 'Usage & costs', group: 'Transport distances' },
  // Choosing WHAT answers is a different job from bounding HOW FAR a run may go — and it is itself
  // two jobs since the second provider arrived: WHO answers (provider + key) and WHICH models do
  // the work. What a model COSTS per token belongs with the model choice; what you have actually
  // SPENT is a different question asked at a different time, so it keeps its own page.
  { key: 'ai-provider', label: 'Provider', group: 'AI' },
  { key: 'ai-models', label: 'Models', group: 'AI' },
  { key: 'ai-limits', label: 'Limits', group: 'AI' },
  { key: 'ai-chat', label: 'Chat', group: 'AI' },
  // External agents driving PrismLCA over MCP: its own page — a server switch and client
  // configurations are not chat settings.
  { key: 'ai-mcp', label: 'MCP', group: 'AI' },
  { key: 'ai-skills', label: 'Skills', group: 'AI' },
  { key: 'ai-tools', label: 'Tools', group: 'AI' },
  { key: 'ai-costs', label: 'Usage & costs', group: 'AI' },
  { key: 'about', label: 'About', icon: InfoIcon }
]

/** The icon in front of a group's heading — the same marks the app uses for the thing elsewhere. */
const GROUP_ICONS: Record<string, () => JSX.Element> = {
  'Transport distances': TruckIcon,
  AI: SparkleIcon
}

/** A fixed 16 px box, whatever size the icon draws itself at (the gear and the sparkle differ). */
function CatIcon({ icon: Icon }: { icon?: () => JSX.Element }): JSX.Element {
  return <span className="settings-cat-icon">{Icon ? <Icon /> : null}</span>
}

/** The rounding fields of the General page, in the order a model is built and then read. */
const ROUND_FIELDS: { key: keyof PrismSettings['round']; label: string }[] = [
  { key: 'edges', label: 'Numbers on the arrows (canvas)' },
  { key: 'properties', label: 'Flow Properties' },
  { key: 'io', label: 'Inputs / Outputs' },
  { key: 'parameters', label: 'Parameters' },
  { key: 'results', label: 'Results' }
]

function clampDigits(v: string): number {
  const n = Math.round(Number(v))
  if (Number.isNaN(n)) return DEFAULT_SETTINGS.round.edges
  return Math.max(1, Math.min(12, n))
}

/**
 * The legacy localStorage keys of the AI settings, cleared on reset so a stale copy cannot be
 * seeded back into main's store on a later start. The settings themselves live in
 * `userData/settings.json` now and are reset by writing the defaults (see the Reset handler).
 *
 * Reset matters most for `disabledTools`, which stores TECHNICAL tool names: the 37 tools folded into
 * consolidated ones during the tool rework left entries behind that matched nothing, with no way to
 * clear them.
 */
const AI_LEGACY_KEYS = [
  'prism.ai.model',
  'prism.ai.writerModel',
  'prism.ai.researchModel',
  'prism.ai.maxRounds',
  'prism.ai.maxCostUsd',
  'prism.ai.maxTokens',
  'prism.ai.focusTools',
  'prism.ai.disabledTools',
  'prism.ai.webSearchEnabled',
  'prism.ai.voiceEnabled',
  'prism.ai.voiceLanguage',
  ZDR_KEY
]

/** Which languages the spell checker underlines against — the five report languages, from
 *  dictionaries shipped with PrismLCA (never downloaded; see main/spellcheck.ts). All unticked = off. */
function SpellcheckFields(): JSX.Element {
  const langs = useAppSettings().spellcheckLanguages ?? ['en-US']
  const isOn = (dicts: string[]): boolean => dicts.some((d) => langs.includes(d))
  const toggle = (dicts: string[]): void =>
    setAS({
      spellcheckLanguages: isOn(dicts) ? langs.filter((l) => !dicts.includes(l)) : [...langs, ...dicts]
    })
  return (
    <>
      <h4>Spell checking</h4>
      {SPELLCHECK_CHOICES.map((c) => (
        <label key={c.code} className="settings-field settings-check">
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={isOn(c.dicts)}
            onChange={() => toggle(c.dicts)}
          />
          <span>{c.label}</span>
        </label>
      ))}
      <p className="settings-hint">
        Text fields are checked against every ticked language — right-click a marked word for suggestions. The
        dictionaries ship with PrismLCA, so nothing is ever downloaded; untick all to switch checking off.
      </p>
    </>
  )
}

/** The start page: may its news card fetch prismlca.com's feed on its own? Off by default — the card
 *  then loads only when clicked (views/overview/NewsCard.tsx). */
function StartPageFields(): JSX.Element {
  const on = useAppSettings().newsAutoLoad === true
  return (
    <>
      <h4>Start page</h4>
      <label className="settings-field">
        <span>Load news from prismlca.com at every start</span>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={on}
          onChange={(e) => setAS({ newsAutoLoad: e.target.checked })}
        />
      </label>
      <p className="settings-hint">
        The start page fetches the news feed from prismlca.com when PrismLCA opens. Off, the news card only
        loads when you click it.
      </p>
    </>
  )
}

export default function Settings({
  onClose,
  initialCategory = 'display',
  focus
}: {
  onClose: () => void
  /** The page to open on. Other places link into Settings (the chat's "+" menu opens Skills). */
  initialCategory?: SettingsCategory
  /** A spot on that page to scroll to and focus — 'add-skill' is the form under the skills list. */
  focus?: SettingsFocus
}): JSX.Element {
  const [cat, setCat] = useState<Category>(initialCategory)
  // A switch that flipped back on its own needs a reason beside it (see setAS).
  const writeError = useAppSettingsWriteError()
  // The title-page fields write through on their own; a refused write must say so here too.
  const [identityError, setIdentityError] = useState<string | null>(null)
  // Grouped categories fold away (two groups of four to seven pages made the rail a
  // long list). Only the group holding the opened page starts unfolded; a heading click toggles.
  const groupOf = (key: Category): string | undefined => CATEGORIES.find((c) => c.key === key)?.group
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const g = groupOf(initialCategory)
    return new Set(g ? [g] : [])
  })
  const toggleGroup = (g: string): void =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })
  // No Save button anywhere: every change applies (and persists) immediately — same
  // behaviour as the AI pages, which always wrote through directly.
  const draft = useSettings()
  const setDraft = (next: PrismSettings | ((d: PrismSettings) => PrismSettings)): void =>
    setSettings(typeof next === 'function' ? next(getSettings()) : next)

  const setRound = (key: keyof PrismSettings['round'], value: string): void =>
    setDraft((d) => ({
      ...d,
      round: { ...d.round, [key]: value === '' ? (0 as number) : clampDigits(value) }
    }))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div className="modal sheet settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Settings</h3>
            <p>
              Everything here applies the moment you change it — there is nothing to save. Reset puts a group
              back to its defaults.
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-cats">
            {CATEGORIES.map((c, i) => {
              const open = !c.group || openGroups.has(c.group)
              return (
                <Fragment key={c.key}>
                  {c.group && CATEGORIES[i - 1]?.group !== c.group ? (
                    <button
                      type="button"
                      className={`settings-cat-group${open ? ' open' : ''}`}
                      aria-expanded={open}
                      onClick={() => toggleGroup(c.group as string)}
                    >
                      <CatIcon icon={GROUP_ICONS[c.group]} />
                      {c.group}
                    </button>
                  ) : null}
                  {open ? (
                    <button
                      className={`settings-cat${cat === c.key ? ' on' : ''}${c.group ? ' grouped' : ''}`}
                      onClick={() => setCat(c.key)}
                    >
                      {c.group ? null : <CatIcon icon={c.icon} />}
                      {c.label}
                    </button>
                  ) : null}
                </Fragment>
              )
            })}
          </nav>
          <div className="settings-panel">
            {writeError ? (
              <p className="settings-hint bad">A setting change could not be saved: {writeError}</p>
            ) : null}
            {cat === 'display' ? (
              <>
                <h4>Rounding (significant digits)</h4>
                {/* Spelled out because "6" reads as decimal places, and then a number that is not
                    the one you typed looks like a bug rather than a setting. */}
                <p className="settings-hint">
                  Digits in total, not decimal places: at 6, 1234.56789 is shown as 1234.57 and 0.00123456789
                  as 0.00123457. Only the display rounds — PrismLCA stores and calculates with the full value,
                  and a field you type into shows it in full while you edit. Results covers the Detailed
                  results page and a dataset&rsquo;s scores; the Results page has its own Decimals control.
                </p>
                {ROUND_FIELDS.map(({ key, label }) => (
                  <label key={key} className="settings-field">
                    <span>{label}</span>
                    <NumberInput
                      min={1}
                      max={12}
                      value={draft.round[key]}
                      onValue={(raw) => setRound(key, raw)}
                    />
                  </label>
                ))}
                <StartPageFields />
                <KeepAwakeFields />
              </>
            ) : cat === 'language' ? (
              <SpellcheckFields />
            ) : cat === 'modelling' ? (
              <>
                <h4>Units</h4>
                <label className="settings-field settings-check">
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.modelling.freeUnits}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, modelling: { ...d.modelling, freeUnits: e.target.checked } }))
                    }
                  />
                  <span>Allow free-text units</span>
                </label>
                <p className="settings-hint">
                  Off (default): unit fields take only known units — ecoinvent&rsquo;s and your models&rsquo;
                  — which catches typos like &ldquo;KG&rdquo; or &ldquo;kwh&rdquo;. On: any unit goes
                  (&ldquo;bottle&rdquo;, &ldquo;wash cycle&rdquo;), known ones are only suggested. It governs{' '}
                  <em>typing</em>: units set by the assistant or imported from a workbook are not bound by it.
                </p>
                <h4>Canvas arrows</h4>
                <label className="settings-field settings-check">
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.modelling.edgeAmounts}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        modelling: { ...d.modelling, edgeAmounts: e.target.checked }
                      }))
                    }
                  />
                  <span>Show the amount and its unit</span>
                </label>
                <label className="settings-field settings-check">
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.modelling.edgeProducts}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        modelling: { ...d.modelling, edgeProducts: e.target.checked }
                      }))
                    }
                  />
                  <span>Show the product</span>
                </label>
                <p className="settings-hint">
                  What the label on each arrow says: how much flows, and under it which product. Turn either
                  off on a crowded canvas; with both off the arrows carry no label at all.
                </p>
                <PreferredBackgroundField />
              </>
            ) : cat === 'reporting' ? (
              <>
                <h4>Title page</h4>
                <p className="settings-hint">
                  Who carries out the studies in this workspace. A report can still add the client&rsquo;s
                  logo and its own cover picture — those sit on the report&rsquo;s title-page settings.
                </p>
                <IdentityFields onError={setIdentityError} />
                {identityError ? <p className="settings-hint bad">{identityError}</p> : null}
              </>
            ) : cat.startsWith('transport-') ? (
              <TransportPanel tab={cat.slice('transport-'.length) as TransportTab} />
            ) : cat === 'ai-provider' ? (
              <AiProviderPanel />
            ) : cat === 'ai-models' ? (
              <AiModelsPanel />
            ) : cat === 'ai-limits' ? (
              <AiLimitsPanel />
            ) : cat === 'ai-chat' ? (
              <AiChatPanel />
            ) : cat === 'ai-mcp' ? (
              <ExternalAgentsSettings />
            ) : cat === 'ai-skills' ? (
              <SkillsPanel focusAdd={focus === 'add-skill'} />
            ) : cat === 'ai-tools' ? (
              <ToolsPanel />
            ) : cat === 'ai-costs' ? (
              <CostsPanel />
            ) : (
              <AboutPanel />
            )}
          </div>
        </div>
        <div className="sheet-foot">
          <span className="meta">Applied immediately · stored on this computer</span>
          <div className="acts">
            {cat === 'display' || cat === 'modelling' ? (
              <button
                className="btn sm"
                onClick={() => {
                  setDraft(DEFAULT_SETTINGS)
                  // The news and keep-awake switches sit on the General page, so its Reset covers them.
                  if (cat === 'display') setAS({ newsAutoLoad: false, keepAwake: true })
                }}
              >
                Reset
              </button>
            ) : null}
            {cat.startsWith('transport-') ? (
              <button
                className="btn sm"
                title="Geocoder, GLEC adjustments and limits back to their defaults. Keys and the recent lookups are untouched."
                onClick={resetTransport}
              >
                Reset
              </button>
            ) : null}
            {cat === 'ai-models' || cat === 'ai-limits' || cat === 'ai-chat' || cat === 'ai-tools' ? (
              <button
                className="btn sm"
                title="Everything on the Models, Limits, Chat and Tools pages back to its default: models and their thinking level, limits, approval, privacy, web search, voice input, Eurostat and the tool switches. Provider, keys, models you added yourself, chats, skills and the cost history are untouched."
                onClick={() => {
                  for (const k of AI_LEGACY_KEYS) localStorage.removeItem(k)
                  // The settings live in main now, so reset means writing the defaults there — and
                  // clearing the old browser keys too, or the next start would seed them back.
                  // Every setting on the four pages that show this button belongs in here: switches
                  // added later used to be missing here and survived a reset.
                  setAS({
                    model: DEFAULT_MODEL_ID,
                    writerModel: '',
                    researchModel: '',
                    reviewModel: '',
                    matchModel: '',
                    maxRounds: DEFAULT_MAX_ROUNDS,
                    maxCostUsd: DEFAULT_MAX_COST_USD,
                    maxTokens: DEFAULT_MAX_TOKENS,
                    writerMaxTokens: DEFAULT_WRITER_MAX_TOKENS,
                    maxResearchQuestions: DEFAULT_MAX_RESEARCH_QUESTIONS,
                    minThroughput: DEFAULT_MIN_THROUGHPUT,
                    reasoningEffort: {},
                    disabledTools: [],
                    zeroDataRetention: DEFAULT_ZERO_DATA_RETENTION,
                    zdrExceptAnthropic: DEFAULT_ZDR_EXCEPT_ANTHROPIC,
                    zdrExceptOpenai: DEFAULT_ZDR_EXCEPT_OPENAI,
                    zdrExceptGoogle: DEFAULT_ZDR_EXCEPT_GOOGLE,
                    focusTools: false,
                    chatApproval: 'irreversible',
                    voiceEnabled: true,
                    voiceLanguage: '',
                    webSearchEnabled: true,
                    webLookupsPerAnswer: DEFAULT_WEB_LOOKUPS_PER_ANSWER,
                    eurostatEnabled: true
                  })
                }}
              >
                Reset AI settings
              </button>
            ) : null}
            <button className="btn sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
