/**
 * What the welcome tour says, card by card.
 *
 * Content only — the frame, the paging and the callout arrows live in WelcomeTour.tsx. Split so the
 * text can be read and argued about in one file without the mechanics in the way: this is the first
 * thing a new user ever reads, and it is the only place where PrismLCA gets to set expectations before
 * somebody spends money or draws a conclusion from a number.
 *
 * The order is deliberate. What sets PrismLCA apart first, then the blocker (no background data, no
 * PrismLCA), then the shape of the app, then the practical half of the AI (keys, models) and what of it
 * leaves the machine — and near the end the two nobody may leave without having read: whose bill the
 * assistant runs up, and that reporting a bug is how it gets fixed. The tour ends on the bug card:
 * the last word should be a request to take part, not a warning.
 *
 * `anchor` names a `data-tour` attribute on a real element of the app. When that element is on
 * screen the tour draws a ring and an arrow to it from outside the card; when it is not — during the
 * very first run everything but the import button is still behind the setup gate — the card simply
 * renders without one. No card may depend on its anchor being there.
 */
import PrivacyLink from '../views/overview/PrivacyLink'
import ChatPreview from './ChatPreview'
import RailPreview from './RailPreview'
import TourLink from './TourLink'
import githubLogo from '../assets/logos/github.svg'
import openaiLogo from '../assets/logos/openai.svg'
import openrouterLogo from '../assets/logos/openrouter.svg'

export interface TourCard {
  id: string
  /** Small line above the heading — where you are in the story, not a section number. */
  kicker: string
  title: string
  body: JSX.Element
  /** The right-hand column: a rebuilt fragment of the UI, or the marks of what is being talked about. */
  visual: JSX.Element
  /** `data-tour` value of the element to ring and point at, if it happens to be on screen. */
  anchor?: string
  /** The label that rides along with the arrow. Short — it is read at a glance, beside the ring. */
  anchorNote?: string
}

export const TOUR_CARDS: TourCard[] = [
  {
    id: 'welcome',
    kicker: 'Welcome to PrismLCA',
    title: 'AI native from the beginning',
    body: (
      <>
        <p>
          Other LCA tools have added a chat window. PrismLCA was built around the assistant from the start —
          so it does the work with you instead of talking about it.
        </p>
        <p>
          <b>The AI modeller</b> puts processes on the canvas, connects the flows and sets the amounts,
          searching your background data as it goes. Every step is undoable and lands in the audit log.
        </p>
        <p>
          <b>Skills</b> teach it how the work is actually done — ten ship with PrismLCA, and you can write
          your own. <b>AI material assignment</b> imports foreign datasets the easy way.{' '}
          <b>The AI report writer</b> drafts the study chapter by chapter from your model and its results.
        </p>
        <p className="wt-muted">
          And if you never switch it on: PrismLCA is a complete LCA tool without any AI — model, calculate,
          report, with no key and, after the first start, no connection.
        </p>
      </>
    ),
    visual: <ChatPreview />
  },
  {
    id: 'data',
    kicker: 'First things first',
    title: 'Bring your own data',
    body: (
      <>
        <p>
          PrismLCA ships with <b>no background data</b>. Until you import some, search finds nothing and no
          result can be calculated. This is the one step you cannot skip.
        </p>
        <p>
          <b>ecoinvent</b> — some <b>26 500 datasets</b> in 3.12 cut-off, and a{' '}
          <b>commercial licence you bring yourself</b>: PrismLCA reads your own ecoSpold2 folder plus the LCIA
          workbook of the same release. No login, no download from inside PrismLCA.
        </p>
        <p>
          <b>BAFU:20XY</b> — the Swiss Federal Administration&rsquo;s inventory database,{' '}
          <b>11 947 datasets, free to use</b>. No licence to buy, no account. If you have no ecoinvent
          licence, this is where you start; if you have one, import both and use them side by side.
        </p>
        <p className="wt-muted">
          BAFU asks to be cited and not resold — the citation goes into your report&rsquo;s bibliography by
          itself, for every database the model actually draws on.
        </p>
      </>
    ),
    anchor: 'background',
    anchorNote: 'Import happens here — now or later.',
    visual: (
      <div className="wt-stack">
        <div className="wt-db paid">
          <div className="wt-db-h">
            ecoinvent 3.x <span className="wt-db-tag paid">commercial</span>
          </div>
          <div className="wt-db-b">
            <b>26 500</b> datasets · your own licence
          </div>
          <div className="wt-db-f">Recommended — its flow list becomes the reference</div>
        </div>
        <div className="wt-db free">
          <div className="wt-db-h">
            BAFU:20XY <span className="wt-db-tag">free</span>
          </div>
          <div className="wt-db-b">
            <b>11 947</b> datasets · Swiss Federal Administration
          </div>
          <div className="wt-db-f">No licence needed — prepared for hassle-free import</div>
        </div>
      </div>
    )
  },
  {
    id: 'rail',
    kicker: 'How PrismLCA is laid out',
    title: 'The rail is the workflow',
    body: (
      <>
        <p>
          The seven entries on the left are not a menu of features — they are the order of a study. Work down
          them and you have done an LCA.
        </p>
        <p>
          <b>Model</b> is where the work happens — processes on a canvas, flows between them — and it is where
          the AI modeller lives. <b>LCIA</b> picks the indicators, <b>Results</b> shows what came out,
          <b>Report</b> turns it into a document.
        </p>
        <p className="wt-muted">
          <b>Parameters</b> and <b>Scenarios</b> are what make a model answer more than one question: give an
          amount a name once, and a scenario is simply one set of values for those names. Change the transport
          distance in the scenario and every process built on it moves with it — no second model, no copy to
          keep in step.
        </p>
      </>
    ),
    anchor: 'rail',
    anchorNote: 'Top to bottom: that is a study.',
    visual: <RailPreview />
  },
  {
    id: 'saving',
    kicker: 'Before you look for it',
    title: 'There is no Save button',
    body: (
      <>
        <p>
          Every change is written the moment you make it — a typed amount, a moved process, a switched
          setting. There is nothing to save and nothing to lose by closing the app.
        </p>
        <p>
          What that needs in return is a way back: <b>Undo</b> in the toolbar takes back the last steps, and
          the <b>audit log</b> beside the canvas records every change with its time and author, including
          everything the assistant did.
        </p>
        <p className="wt-muted">
          A whole model travels as a single <span className="wt-code">.prism</span> file: export it, send it,
          import it somewhere else. Underneath, each one is an ordinary <b>Brightway</b> database — your work
          stays readable with Brightway itself, with or without PrismLCA.
        </p>
      </>
    ),
    visual: (
      <div className="wt-stack">
        <div className="wt-log">
          <div className="wt-log-h">Audit log</div>
          <div className="wt-log-row">
            <span className="wt-log-t">14:02</span>Amount set · electricity, medium voltage
          </div>
          <div className="wt-log-row">
            <span className="wt-log-t">14:02</span>Process added · packaging, glass
          </div>
          <div className="wt-log-row ai">
            <span className="wt-log-t">13:58</span>Assistant · linked 3 background datasets
          </div>
          <div className="wt-log-row">
            <span className="wt-log-t">13:51</span>Model created
          </div>
        </div>
        <div className="wt-note">Written through — no Save, no unsaved-changes dialog.</div>
      </div>
    )
  },
  {
    id: 'search',
    kicker: 'Before your first search',
    title: 'Find datasets by meaning',
    body: (
      <>
        <p>
          Search takes plain description, not database vocabulary. Ask for <i>“freight transport by truck”</i>{' '}
          and ecoinvent&rsquo;s <b>lorry</b> datasets come up: the word you know is not the word in the
          database, and it does not have to be. Leave the country out of the words, though — a region is a
          filter beside the field, not part of the description.
        </p>
        <p>
          Two searches run at once and are merged: one on <b>meaning</b>, where every dataset is embedded as a
          vector, and one on <b>wording</b>. So a term you half-remember or spell differently still lands, and
          a description in your own words finds a dataset named nothing like it.
        </p>
        <p className="wt-muted">
          The assistant searches through the very same index — <b>retrieval-augmented generation</b> with your
          own databases as the source. That is what lets it reach for datasets that exist instead of inventing
          plausible names.
        </p>
      </>
    ),
    visual: (
      <div className="wt-search">
        <div className="wt-search-q">freight transport by truck</div>
        <div className="wt-hit">
          <span className="wt-tag market">meaning</span>
          <span className="wt-hit-name">market for transport, freight, lorry, unspecified</span>
        </div>
        <div className="wt-hit">
          <span className="wt-tag market">meaning</span>
          <span className="wt-hit-name">transport, freight, lorry 16–32 metric ton, EURO6</span>
        </div>
        <div className="wt-hit">
          <span className="wt-tag prod">wording</span>
          <span className="wt-hit-name">market for lorry, 16 metric ton</span>
        </div>
      </div>
    )
  },
  {
    id: 'byok',
    kicker: 'The optional half',
    title: 'Bring your own key',
    body: (
      <>
        <p>
          The AI assistant runs on a key of your own — PrismLCA sells no tokens and adds no margin. Two
          providers are implemented:
        </p>
        <p>
          <b>OpenRouter</b> — one key, one balance, and the catalogues of many labs behind it. Switch the
          model in PrismLCA whenever you like, including mid-study.
          <br />
          <TourLink href="openrouter.ai/keys" />
        </p>
        <p>
          <b>OpenAI</b> — a key straight from the source, if you would rather have one vendor and one invoice.
          <br />
          <TourLink href="platform.openai.com/api-keys" />
        </p>
        <p className="wt-muted">
          The key is stored encrypted on this machine and never reaches us. What does leave your machine is
          the model data you ask about — it goes to the provider you picked.
        </p>
      </>
    ),
    anchor: 'settings',
    anchorNote: 'Settings → AI → Provider: paste your key here.',
    visual: (
      <div className="wt-stack">
        <div className="wt-prov">
          <img src={openrouterLogo} alt="" className="wt-prov-logo" />
          <div>
            <div className="wt-prov-name">OpenRouter</div>
            <div className="wt-prov-sub">Many labs, one key · switch models freely</div>
          </div>
        </div>
        <div className="wt-prov">
          <img src={openaiLogo} alt="" className="wt-prov-logo" />
          <div>
            <div className="wt-prov-name">OpenAI</div>
            <div className="wt-prov-sub">Direct · one vendor, one invoice</div>
          </div>
        </div>
        <div className="wt-note">Keys are stored encrypted, locally. PrismLCA never sees them.</div>
      </div>
    )
  },
  {
    id: 'models',
    kicker: 'Choosing a model',
    title: 'A better model models better',
    body: (
      <>
        <p>
          The model you pick is the single biggest lever on how well the AI assistant works — and on what it
          costs. A stronger model makes better assumptions and fewer silent mistakes, and it costs more: per
          token, the priciest here costs about a hundred times the cheapest.
        </p>
        <p>
          PrismLCA starts you on <b>GPT-6.1 Sol</b>, which is solid in everyday modelling at a moderate cost;{' '}
          <b>Claude Sonnet 5.5</b> and <b>Gemini 4 Argon</b> are in the same price range. <b>GPT-6 Luna</b>{' '}
          and <b>Claude Haiku 5.5</b> cost a fraction of it, enough for simple tasks.
        </p>
        <p>
          <b>If the assistant disappoints you, change the model before you change your plan.</b> The top tier
          — <b>Claude Opus 5.5</b>, <b>Claude Fable 5.1</b>, <b>GPT-6 Astra</b> — is one dropdown away, and it
          is usually the difference between an answer you correct line by line and one you only check.
        </p>
      </>
    ),
    anchor: 'settings',
    anchorNote: 'Settings → AI → Models: the model dropdown.',
    visual: (
      <div className="wt-ladder">
        <div className="wt-lad-row">
          <span className="wt-lad-bar top" />
          <div>
            <div className="wt-lad-name">Opus 5.5 · Fable 5.1 · GPT-6 Astra</div>
            <div className="wt-lad-sub">The top tier — highest bill, for when quality decides</div>
          </div>
        </div>
        <div className="wt-lad-row">
          <span className="wt-lad-bar mid" />
          <div>
            <div className="wt-lad-name">GPT-6.1 Sol — your default · Claude Sonnet 5.5</div>
            <div className="wt-lad-sub">Solid in practice, moderate cost</div>
          </div>
        </div>
        <div className="wt-lad-row">
          <span className="wt-lad-bar low" />
          <div>
            <div className="wt-lad-name">GPT-6 Luna · Claude Haiku 5.5</div>
            <div className="wt-lad-sub">Very cheap, enough for simple tasks</div>
          </div>
        </div>
      </div>
    )
  },
  {
    id: 'privacy',
    kicker: 'What leaves this computer',
    title: 'Eight doors out — every one of them opened by you',
    body: (
      <>
        <p>
          Your models, databases and reports stay on this machine — no account, no cloud, no telemetry, and
          the search index behind RAG is built and queried right here.
        </p>
        <p>
          <b>Eight features</b> reach the internet, and only these eight, each on your say-so. The list beside
          this names every one and what goes where. With no key, PrismLCA&rsquo;s own AI features send
          nothing.
        </p>
        <p>
          The assistant&rsquo;s tools can be <b>switched off</b> under <b>Settings → AI → Chat</b> and{' '}
          <b>Tools</b> — a tool that is off is invisible to the assistant, not merely discouraged. The news
          loads only if you allow it; its switch is under <b>Settings → General</b> and starts off.
        </p>
        <p className="wt-muted">
          The whole list, with what goes to whom: <PrivacyLink plain />.
        </p>
      </>
    ),
    anchor: 'settings',
    anchorNote: 'Settings: every door, individually.',
    // One line per door — the place the rule "every channel gets a line on this card" is kept. The prose
    // beside it no longer repeats the list: told twice, the card ran to twice its height.
    visual: (
      <div className="wt-doors">
        <div className="wt-doors-row">
          <b>AI assistant, web search, report writer, import matching</b> → OpenRouter or OpenAI; a PDF for a
          model that cannot read PDFs is turned into text at Cloudflare
        </div>
        <div className="wt-doors-row">
          <b>Voice input</b> → your recording to Whisper, via the same provider
        </div>
        <div className="wt-doors-row">
          <b>Transport distances</b> → place names to OpenRouteService / Mapbox
        </div>
        <div className="wt-doors-row">
          <b>Waste statistics</b> → country and material to Eurostat
        </div>
        <div className="wt-doors-row">
          <b>News on the start page</b> → prismlca.com, if you allow it
        </div>
        <div className="wt-doors-row">
          <b>Search model, once</b> → huggingface.co, after you agree on first start
        </div>
        <div className="wt-doors-row">
          <b>Update check</b> → your version to github.com, only when you click in Settings → About
        </div>
        <div className="wt-doors-row">
          <b>MCP server</b>, the other way: switched on under Settings → AI → MCP, an AI client you connect
          yourself (Claude Code, Codex) drives PrismLCA; what it reads goes to that client&rsquo;s provider,
          not through PrismLCA
        </div>
      </div>
    )
  },
  {
    id: 'bill',
    kicker: 'Before you spend anything',
    title: 'Your keys, your bill',
    body: (
      <>
        <p>
          When you enter a key, the contract is between <b>you and the AI provider</b> — not with PrismLCA.
          Every request the assistant makes is billed to your account by that provider, on their terms.
        </p>
        <p>
          PrismLCA does try to keep it in check. There is a <b>cost limit per run</b> — $15 by default, under
          Settings → AI → Limits — and a <b>Usage &amp; costs</b> table under Settings → AI showing what each
          provider and each kind of work has cost you so far.
        </p>
        <p>
          Take that as a helper, not a promise. PrismLCA is beta, and a safety net in beta can tear. A{' '}
          <b>hard spending limit at the provider</b> does not depend on PrismLCA at all. Set one before you
          start — it takes a minute.
        </p>
        <p className="wt-muted">
          <TourLink href="openrouter.ai/settings/credits" /> ·{' '}
          <TourLink href="platform.openai.com/settings/organization/limits" />
        </p>
      </>
    ),
    anchor: 'settings',
    anchorNote: 'Settings → AI → Limits and Usage & costs.',
    visual: (
      <div className="wt-stack">
        <div className="wt-field">
          <span className="wt-field-l">Cost limit per run ($)</span>
          <span className="wt-field-v">15</span>
        </div>
        <div className="wt-note soft">
          PrismLCA&rsquo;s brake — helpful, and only as reliable as beta software.
        </div>
        <div className="wt-hard">
          <div className="wt-hard-h">Hard limit at your provider</div>
          <div className="wt-hard-b">
            Set a monthly cap or prepay a fixed balance. This one holds even if PrismLCA fails.
          </div>
        </div>
      </div>
    )
  },
  {
    id: 'bugs',
    kicker: 'Last one — and the one we ask of you',
    title: 'Tell us what breaks — and what you miss',
    body: (
      <>
        <p>
          You will hit rough edges. Something will refuse to import, a chart will come out wrong, a dialog
          will not close. None of that is wasted if you tell us about it.
        </p>
        <p>
          <b>&ldquo;It doesn&rsquo;t work&rdquo; is the step before it works.</b> Every report is the reason
          the next version is better — and a rough edge nobody names is one nobody fixes.
        </p>
        <p>
          The same place takes <b>feedback</b> and <b>feature requests</b>: something that felt clumsy,
          something an LCA needs that PrismLCA cannot do yet. Say what you were trying to achieve — that is
          worth more than a guess at how to build it.
        </p>
        <p className="wt-muted">
          What helps most in a bug report: what you did, what you expected, what happened instead, and the
          version from the Overview page.
        </p>
      </>
    ),
    visual: (
      <div className="wt-stack">
        <div className="wt-gh">
          <img src={githubLogo} alt="" className="wt-gh-logo" />
          <div className="wt-gh-url">
            <TourLink href="github.com/prismlca/prismlca/issues" />
          </div>
          <div className="wt-gh-sub">Issues · bugs, feedback, feature requests</div>
        </div>
        <div className="wt-issue">
          <div className="wt-issue-row">
            <span className="wt-issue-l">What I did</span>Imported an ecoSpold2 folder
          </div>
          <div className="wt-issue-row">
            <span className="wt-issue-l">Expected</span>The datasets to show up in search
          </div>
          <div className="wt-issue-row">
            <span className="wt-issue-l">Instead</span>&ldquo;0 datasets&rdquo; and no error
          </div>
        </div>
        <div className="wt-note">Three lines are enough. A named rough edge is a fixable one.</div>
      </div>
    )
  }
]
