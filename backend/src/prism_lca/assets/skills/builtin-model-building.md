# Building an LCA model in PrismLCA

Follow this workflow whenever the user asks you to build, extend, or restructure an LCA model. The order
of work, one line per section:

1. **Read the brief** and record the study with `model_info` — before anything else.
2. **Ask** what only the user can decide, with options — up front, and later only what would move the result.
3. **Structure**: the life cycle on top, the product's own chain beneath it, phases as tags.
4. **Link the background**: open the datasets that carry the result first; mind units, losses and waste
   signs.
5. **Document as you build**: every process gets its description in the call that creates it.
6. **Parameterise** what varies, so scenarios can move it.
7. **Close the data gaps** the databases leave: the user's figures first, then the sources this chat has.
8. **Verify before you report**: health check, numbers, the flows of the leading phase, the dominant
   assumption, a review.
9. **Record** what you could not resolve, and write the result up as what it is.

## 1. Read the brief first

**Always call `model_info` action="get" before substantive modelling work.** The study metadata is the
contract for what you build: ISO 14044 requires it, the report writes its goal-and-scope chapter from it
(an empty field prints as "not defined"), and every later decision is judged against it. Keep it updated
with action="set" whenever the user decides something new (the user edits the same fields via *Info*).

Before adding processes, make sure you know:

- **Product and functional unit (FU)** — what exactly is assessed, per what quantity ("1 kg of bread, at
  bakery gate"). The FU anchors every amount. **Keep the FU text short and functional**: "1 watering can
  (10 l, incl. rose), delivered to the retailer", not the retail listing. Every chapter that cites the FU
  prints it verbatim, so a trade name in it ends up all over the document (one report printed a brand six
  times); trade designation, EAN and retailer go once into the scope's product description.
- **System boundaries** — cradle-to-gate, cradle-to-grave, gate-to-gate, and which stages are excluded
  (capital goods, use phase).
- **Geography and time reference** — they decide which background datasets fit, and each has a field:
  `geography` (where the product is made, sold, used and disposed of — "made in Poland, sold in Germany")
  and `reference_year` (the year the data should represent). The market is for the brief or the user to
  say: **the language of the conversation says nothing about it** — a German-speaking user may be
  assessing a product sold in Brazil. If neither the field nor the brief names it, ask (section 2) and
  record the answer. The year needs no question of its own: when nobody gives one, take the year of the
  user's data, or else the current year, record it and say so — or add it to a question you ask anyway.
- **Impact focus** — carbon footprint only (IPCC GWP100, `recommended: true`) or a broader set.
- **The people the report's title page prints**: **author**, **organisation** (who carried the study
  out), **commissioner** (who it was for) and **critical_review** (who reviewed it, if anyone). Write what
  you were told, negative answers included. Whether a critical review took place is a yes/no only the user
  sets in Model info, so no sentence of yours can switch off the ISO 14044 §7.3.3 note a published
  comparative assertion needs — you never have to phrase around it.

**Set the study `language` at the start and honour it.** Default English; take the user's wish, otherwise
the language of the conversation, and record it. From then on write ALL study text in it: goal & scope
fields, **process names**, process comments, scenario names and descriptions, parameter comments,
limitations, tag *values*. **Two things are identifiers and stay as they are: parameter names and tag group
(dimension) names** — the software finds things by them, and the report translates a dimension's printed
name itself. Mixed languages make a mixed-language report, and the usual way there is writing notes in the
language of the conversation instead of the study's.

If any of this is missing or vague, ask (section 2) instead of guessing, and persist the answer with
`model_info` so the next session starts informed.

## 2. Ask what is the user's to decide

For **discrete decisions**, use `ask_user` (clickable options, a machine-readable answer) instead of a
plain-text question: system boundaries, candidate functional units, the market the product is made and sold
in, a geography fallback (country → RER → GLO), several plausible background datasets, a destructive action. Free text only for genuinely open questions
("describe the recipe"). Ask in one question what belongs together, and never ask what the goal & scope
already answers. **When the user has said not to ask**, every "ask" in this skill becomes: decide, write the
decision into the comment it concerns, and record it as an assumption (section 9).

**The question that keeps being skipped: what the functional unit may carry.** Some choices are not data
you can look up — picking one silently makes the number yours instead of the user's. Ask before
modelling, with options:

- **Shared infrastructure and shared consumption.** A hair wash uses a shower, a coffee a machine, a wash
  cycle a household's water. How much of it belongs to *this* FU is an allocation decision: one study
  charged 15 litres of hot water to one dose of shampoo, which then carried 87 % of the total — a choice
  nobody was asked to make, reported afterwards as an "uncertainty".
- **Where the boundary cuts** when the brief leaves it open: the energy to heat water, the appliance, the
  household's own losses?
- **Which reference flow** the FU means — per wash, per bottle, per year of use.
- **A proxy that carries much of the result.** Substituting a dataset is yours to do; one that turns out to
  drive a fifth of the score is worth naming, with alternatives.

The test: *if the user later disagrees with this, does the headline number change?* If yes, it was theirs
to decide. Ask once, with two or three concrete options and the consequence of each — not a paragraph of
context and an open question.

**Questions do not stop when the build starts, but they get rarer.** Most belong up front. Later, ask only
what passes the same test and could not have been asked before: no dataset fits and every candidate moves
the result, a figure from the brief contradicts the data you find, a process turns out to carry most of the
score on an assumption nobody stated. Ask it when it comes up, as one question with options. Two
candidates that both fit are no such case: pick one and say why in the exchange comment. Everything else
you decide yourself, write into the comment it concerns, and record as an assumption (section 9) — the
user can overrule it there.

## 3. Build the life cycle on top and the product's own chain beneath it, and tag it by phase

**Do not connect background processes (ecoinvent, BAFU) directly to the main product node.** The main node
holds the life cycle; beneath it the product is made the way a person at the plant or in the shop could
point at, one process per real step; and tags carry the phases:

1. **The main node is the functional unit and holds the life cycle side by side** — one link per stage,
   and nothing else:
   - the **delivered product**: the last step of the product's chain (usually Distribution), in the amount
     one functional unit takes of it — 0.002 bottles when a bottle serves 500 litres;
   - **Use**: a process holding what using the product consumes per functional unit (water, energy,
     detergent) — without the product itself, which the line above already brings;
   - **End of life**: the treatment of what is thrown away, in the same share as the product (0.002 bottles).
   A stage the study does not include stays out: a cradle-to-gate study links only the product at the gate
   (Manufacturing), and a product whose use consumes nothing gets no Use process. The main node carries no
   tag.

2. **Beneath the delivered product, one chain in the order the product is made**, each process holding
   exactly the inputs its step consumes:
   - *Manufacturing* takes the materials, the processing services (injection moulding, metal working,
     extrusion), its energy, its scrap and the freight that brings its materials in, where section 4 says
     to book one. Material and processing sit **next to each other** in the same
     process: a processing dataset covers the work, not the material, and the material is its second input.
     A product of several parts may have a process per part, consumed by an assembly step.
   - *Distribution* takes the manufactured product plus transport and packaging.
   - Every amount is a plain per-unit fact of its own step ("one bottle at the shop takes one bottle from the
     factory and 0.07 tkm of lorry"); the main node's link is the only one that converts to the functional
     unit.
   - **The chain is the only way to Manufacturing.** Nothing else consumes the manufactured or the delivered
     product — not the main node a second time, not Use. A second link counts the product twice.
   Name each process step first, product second ("Manufacturing — bottle"). A reusable bottle, per litre
   carried (one manufacturing process here; a process per part with an assembly step above them is just as
   right):

       1 litre carried                       main node, no tag
       ├── Distribution — bottle    0.002    Distribution: 1 manufactured bottle, sea and lorry, box
       │   └── Manufacturing — bottle    1   Production: steel, PP, silicone (inputs "Raw materials"), forming
       ├── Use — per litre          1        Use: rinse water, heat, wastewater
       └── End of life — bottle     0.002    End-of-life: lid and seal incinerated

3. **Tag every foreground process with its phase** in the group `Life-cycle phase`. The standard set is
   **Raw materials, Inbound transport, Production, Distribution, Use, End-of-life**: Manufacturing takes
   "Production", Distribution "Distribution", Use "Use", End of life "End-of-life", and the first two
   mostly sit on inputs (step 4). In an English study use the spellings the workspace already uses, so
   models can be compared phase by phase; in another study language the values follow it (section 1), the
   group name does not. The set is a default, not a limit: a product with a stage of its own — installation
   on site, maintenance, refurbishment — gets an extra value in the same group. A breakdown that is not a
   phase at all (by component, by supplier) gets a group of its own, never a value in this one.

   A process without a tag counts under the phase of the process that consumes it, with everything below
   it. So ask of every process: **does it belong to one phase?** Then tag it with that phase — a part made
   beneath Manufacturing takes "Production" as well, even though it would inherit it. Leave a process
   untagged only when it should count with whoever consumes it: a helper that steps of different phases
   share (a formulation dosed in Production and refilled in Use). `check_model_health` names every untagged
   process and the phase it falls into. Packaging is no phase of its own: the box is an input of the step
   that packs (usually Distribution) and carries "Raw materials" like any material (step 4) — a process of
   its own for it is not needed, and if you model one, tag it "Raw materials" too.

4. **Tag the inputs that belong to another phase than their process.** Two kinds do:
   - **Materials** a manufacturing step consumes are the raw-material phase, not production: steel,
     polymer granulate, glass, purchased parts and components, and the production of the packaging — tag
     "Raw materials".
   - **Freight that brings them to the plant** — the lorry or ship leg you booked next to a material
     because a production dataset was linked or the material travels further than its market's average
     (section 4) — tag "Inbound transport". A market's own transport is inside the market and gets nothing.

   Tag an input when you link it (`edit_exchange` action="add" with
   `tags: {"Life-cycle phase": "Raw materials"}`) or afterwards, all in one call: `edit_tags`
   action="assign", group "Life-cycle phase", the value, `keys` a list of `{ uid }` — the uids come back from
   `edit_exchange` and are on every edge of `get_model_graph`. Every other input stays untagged and counts
   under the phase of its process — processing services, energy, in-plant transport and transport between
   your own sites under Production, the freight that carries the finished product to the customer under
   Distribution, rinse water under Use. Only inputs from outside the model take a tag of their own; a
   process of the model is tagged on the process (a "Transport — granulate to plant" you modelled as a
   process carries "Inbound transport" itself).
   **This is the one mistake no check sees:** an untagged steel input of Manufacturing computes correctly
   and lands in Production, and the phase table then says the product has no raw materials. Before you
   calculate, read the edges of `get_model_graph` once and confirm every material input of a manufacturing
   step carries "Raw materials" and every inbound freight leg "Inbound transport".

5. **Reuse the vocabulary before creating it**: call `list_tags` first. Only create the group
   **"Life-cycle phase"** (`edit_tags` action="create_group", then action="add_value" per phase) when nothing
   existing fits; never shoehorn phases into a group that means something else. The group name stays
   `Life-cycle phase` in every study language (section 1) — it is what lets two models be broken down the
   same way; its values follow the language ("Herstellung", "Nutzung").

6. **Re-wiring is a move, not an addition.** Adding a new link without deleting the one a process hung from
   before leaves *both* live, and the two amounts are summed: the step is counted twice and the total comes
   out too high, by a quarter or more, with every number still individually plausible. So for each process
   you re-hang, `edit_exchange` action="remove" the old link in the same batch as the new one, then call
   `check_model_health` — it reports a process the reference process and something else both consume, and
   one nothing consumes any more — and compare the score against what it was before.

7. Result: the breakdown follows the tags exactly — `explain_result` with
   `aggregate_by: "tag:Life-cycle phase"`, the stacked bars in the Results view, and
   `explain_result` mode="flows" with `phase: {"dimension": "Life-cycle phase", "value": "…"}` for the
   emissions of one phase, wherever its processes and inputs sit.

A model built the older way — one process holding all materials and another all processing, both straight
under the main node — is still valid and computes the same; do not rebuild it unless asked. New models
follow the steps above.

## 4. Link the background datasets

- Prefer **market** activities as inputs; match geography to the study with the cascade local → regional
  (e.g. RER) → GLO/RoW. Give `search_background` **one** geography — that ranks the region first and keeps
  RER/GLO/RoW as fallbacks. A **list** of geographies is a hard filter and hides datasets that only exist
  elsewhere (the generic wastewater treatment lives in `Europe without Switzerland`, `CH` and `RoW`); the
  answer then says so in `outside_geography_filter`. When a dataset you expect does not appear, search once
  **without** geographies before reaching for a proxy, and record a geography proxy in the exchange comment.
  `lookup` kind="geographies" lists the regions a database actually holds, with plain names, and whether
  each is a country or an aggregate — use it to find a code ("europe" finds RER) or to check that one
  exists before you filter on it.
- **Transport is a decision, not a default.** A *market* already includes average transport to the
  consumer — do not book generic delivery on top of one. Book explicit transport where it is not in the
  data: when a *production* dataset is linked directly, when a known leg differs from the market's average
  (a material shipped from overseas to your plant, an imported finished product's sea freight), and
  between your own steps when they plausibly happen at different sites. That last one may legitimately be
  zero (one site); decide it consciously — ask, or state the assumption. Freight into the plant is
  "Inbound transport", freight to the customer is Distribution (section 3, step 4).
- **Open the datasets that will carry the result BEFORE you link them** — not after the contribution
  analysis, when a baseline, scenarios and a quoted number already rest on the choice. You know the handful
  while you build: the battery in a battery-powered device, the metal in a metal product. **Do not stop at
  the materials**: the list always also holds **the biggest energy input, the biggest transport item and the
  secondary packaging**. A study of a jar of apple sauce opened six datasets before linking — apples, glass,
  steel, waste glass, waste water, every one a material and every one small; the four that carried **78 %**
  of its result were process heat, the parcel's last mile, the shipping carton and the line-haul lorry, and
  none of them had been looked at. If your product is heated, dried, cooled, driven or posted, that is where
  the result lives.

  Read them with `get_process_details` (one call takes a `codes` list; `summary=true` is enough), for two
  things a search hit does not show:
  - **The comment** — it says what the dataset was built for while the name stays generic. `printed wiring
    board production, surface mounted, unspecified, Pb free` is based on boards "for desktop and laptop
    computer"; `battery production, NiMH, rechargeable` is a battery "for laptop applications". A study used
    both for a small garden solar lamp, at 44 % and 41 % of its result.
  - **The dataset's own inputs** — one that draws a different named material in bulk is not that material
    but a product made from it (a "binder" carrying 0.25 kg of titanium dioxide per kilogram) or a service
    applied to it (`market for section bar extrusion, aluminium` supplies the *extruding*, not the metal — a
    study was a factor of 2 out on that one).

  For a **market**, read the producer behind it: a market's comment is boilerplate, and the sentence you
  need sits one level down. What you find goes into the exchange comment — and, if it could change the
  conclusion, into a scenario with a different dataset.
- **Every amount is in the consumed process's own reference unit**: how much of *that* process's reference
  product one unit of the consumer takes — kilograms for a per-kilogram process, pieces for a per-piece one;
  check the input's unit in the search result before setting it, and convert where yours differs (0.5 l of
  rinse water is 0.5 kg for a per-kilogram tap-water dataset). A count that is right for one step is
  wrong for the next: `1 / washes_per_bottle` is the share of a *bottle* per wash and, on a formulation
  measured in kilograms, silently means 41 g of shampoo where the dose is 10.5 g. It computes and looks like
  a fraction, and no check can know what a kilogram of your product is. So walk the chain once: state in
  words what one unit of each consumer takes, check the amount says that, and write the check into the
  exchange comment.
- **Model the losses that matter**: harvest and sorting losses, rejects and breakage in production and
  filling (a filling line scraps bottles), the yield of a conversion step, transport and retail losses of
  perishables. A loss is **more input per unit of output** (a 2 % reject means 1.02 bottles per filled
  bottle), its rate a parameter a reviewer will want to vary. Ask, or estimate and label; if you exclude
  losses, say so in the scope. Read a background converting step's comment first: some datasets already
  carry their loss (do not book a second one), and a stated yield is a better source than any estimate.
  **The packaging has losses too**, and packaging often carries a large share of a packed product's
  result: a filling line breaks glass and scraps labels and film, and every unit lost in distribution or
  retail takes its packaging with it. So put the loss on the packaging inputs as well, not only on the
  product.
- Waste-exchange signs depend on the provider's reference product — and **the dataset's name does
  not tell you which case you are in**. Two datasets that both look like "end of life" sit side by
  side in the same search result and demand *opposite* signs. So: read the sign of the provider's
  reference product first (`search_background` reports it; `get_process_details` shows it in full),
  then match the exchange amount to that sign. Never infer it from the name — and when two background
  databases are released, check the hit's `database` too: **ecoinvent 3 and BAFU:20XY use opposite
  conventions for disposal.**
<!-- if ecoinvent -->
  - **ecoinvent treatment activities** — incineration, landfill, wastewater, and waste *markets* that
    charge for disposal (e.g. `market for waste glass`) — have a **negative reference product**: model
    "send 0.1 kg to this route" as that input with amount **-0.1**.
  - **Recycling treatments and waste markets that trade the waste as a good** (e.g. `treatment of
    X, recycling`, `market for waste packaging paper`) have a **positive** reference product —
    they SELL the recycled material. A positive input of one of these means *buying recyclate*.
    That belongs on the **input side** of a product made from recycled material — and never in its
    end-of-life phase: under cutoff the share of YOUR waste that goes to recycling leaves the
    system burden-free, so you **link nothing at all for it** — not even with amount 0 as a note; the
    fate belongs in the End of life comment. (Linking one of these with a
    negative amount is wrong the other way round: it runs the activity backwards and turns its
    burdens into phantom credits.)
  - Consequence worth internalising: a finished end-of-life process built on ecoinvent carries
    **negative** treatment exchanges for incineration/landfill/wastewater and **no exchange** for the
    recycled share. Seeing a positive "recycling" input inside an end-of-life process is the tell that
    disposal is being charged for producing recyclate it never uses.
<!-- endif -->
<!-- if bafu -->
  - **BAFU:20XY disposal datasets** (`Disposal, <material>, to municipal waste incineration`, `…, to
    sanitary landfill`, `…, to recycling`, `Treatment, sewage, …`) are **services with a positive
    reference product** (ecoSpold 1, ecoinvent-2 convention): model "send 0.1 kg to this route" as
    that input with amount **+0.1**. A negative amount here runs the disposal backwards and turns its
    burdens into phantom credits.
  - BAFU has **no waste markets and no separate recyclate markets**: recycled content is built into
    the material datasets themselves (names such as `… recycling share 2008 (98% Rec.)`, `… high
    recycling share`). A product made of recycled material takes the matching material dataset as a
    normal positive input; the share of YOUR waste that goes to recycling leaves the system
    burden-free — link nothing for it, take no credit.
  - Consequence worth internalising: a finished end-of-life process built on BAFU carries
    **positive** disposal exchanges and **no exchange** for the recycled share.
<!-- endif -->
  - **Before you model an end-of-life phase, load the *End-of-life & what-if scenarios* skill**
    (`get_skill`). It carries the full decision table (recycled content vs. closed-loop vs. your
    waste to recycling) and a worked example of exactly the mistake above — these rules are easy
    to get wrong from memory, and one run did.
  - Whichever sign you use, **write the reason into the exchange comment** (`edit_exchange`
    action="set_comment", or pass `comment` when adding): "negative — provider's reference product
    is negative (ecoinvent treatment)" or "positive — BAFU disposal service, reference product
    positive". This is the one place a reviewer can check the decision without re-deriving it, and
    mixed signs across a model are otherwise indistinguishable from a mistake.
- Direct emissions/resources: `search_elementary_flows` → `edit_exchange` with type "biosphere".

## 5. Document every process as you create it

A foreground process without a description is a number nobody can defend. `create_process` **takes the
comment with it**: write it in the call that creates the process — not once the structure is in place, not
at the end. Every run that left it for later lost the sources, because the round budget ran out first. Two
or three sentences, covering both:

1. **What the process is**: what it represents, what it covers, what it deliberately excludes.
2. **Where its data comes from, and how firm it is** — say which of these it is:
   - the user's own data ("mass given by the user"),
   - your own estimate, said plainly ("estimated from typical values for LDPE film extrusion; no primary
     data"),
   - a statistic or a published figure, with the **source**: title, publisher, year and the exact URL, as a
     report would cite it.
<!-- if web -->
     If you used `research_web` or `research_bom`, carry its sources over rather than summarising them away.
<!-- endif -->

These descriptions are **not printed**: they are what the Life cycle inventory chapter is written *from*,
the documentation ISO 14044 §4.3 asks for, and the writer may not invent what a process is. So they need
not be polished, but they must be **complete and precise** — facts, sources and honest uncertainty, no
"see above". Background datasets bring their own documentation; this is about **your** processes.

**A URL or "own estimate" — never a bare institution name.** "UBA/GVM 2022" or "industry typical" looks
checked and is not, which makes it worse than both: carry the full reference through, or write "own
estimate, no primary source" and let the limitations say so.

**Exchanges take comments too** (`edit_exchange` with `comment` when adding, or action="set_comment"): what
belongs to the *amount* or the *choice of input* rather than the process — a waste sign, a proxy standing in
for the real dataset, why this dataset and not its equivalent, what a formula expresses, where a distance or
rate came from. The report's inventory and interpretation writers read them beside their process and input,
so the rule for descriptions holds here too: complete and precise, two or three sentences, and said once — a
reason on the exchange is not repeated in the process description.

## 6. Parameterise what varies

A figure typed straight into an exchange is a decision nobody can revisit. Create a **parameter** and put a
formula on the exchange whenever a number is not a settled constant:

- it appears in more than one place (a mass that drives material, transport and disposal alike),
- the user was unsure of it, or it is not their own data but a statistic, a published figure or an estimate,
- it is a rate, share or distance — the things a reviewer asks "and if it were different?" about,
- you can already imagine varying it.

`edit_parameter` action="set" creates or updates it (value **or** formula, plus unit/group/comment);
`edit_exchange` action="set_formula" makes an amount depend on it — the uid comes from
`get_process_details`. A change to one number then moves every dependent amount, and the annex's parameter
table documents the study for free.

**Scenarios are named sets of parameter overrides** — the pay-off for parameterising and the only way the
report can say anything about sensitivity: `edit_scenario` action="create" (a name plus overrides), scored
with `compare_scenarios`. Which ones to build follows from the result (section 8, step 5).

Do not over-parameterise: a stoichiometric ratio or a fixed unit conversion is a constant, and turning it
into a parameter only adds a way to get it wrong.

## 7. Close the gaps the databases leave

The released background databases are the primary source for inventory data. What they do not hold — an
end-of-life split, a composition, a mass nobody gave you — comes from these sources, in this order:

- **The user's own figures.** What the brief or the conversation gives you comes first. A figure that
  carries the result and that you do not have: ask for it (section 2) before you fill it any other way —
  the user may have the data, or want to keep their assumption.
<!-- if eurostat -->
- **Eurostat, for end-of-life in the EU.** `eurostat_eol` reads the official waste statistics directly —
  treatment mix, recycling and collection rates per country, material and year. It is a tool of its own,
  not a web search, and for an EU figure it comes before any web search. Which table fits which product,
  and how the split becomes parameters, is in the *End-of-life & what-if scenarios* skill.
<!-- endif -->
<!-- if web -->
- **The web**, as a secondary source, where it genuinely improves the model:
  - **A specification the user cannot give** (material shares, mass, grammage): check or improve your
    assumption against manufacturer data sheets and product studies instead of guessing silently —
    `research_bom` for a whole bill of materials (the *Bill of materials* skill), `research_web` for
    single figures.
  - **Statistics**: end-of-life splits and similar shares per material and country come from official
    sources (national statistics offices, Eurostat, EPA) and industry associations (PlasticsEurope), not
    from an invented split.

  Ask first with `ask_user`, best together with the questions you ask up front: one short question such
  as "Look up typical masses for this lamp?" with "Yes, look it up" / "No, use my numbers or a rough
  assumption". Web figures are approximations; say so in the answer.
<!-- endif -->
- **Your own estimate**, last — labelled as one, never dressed up as sourced.

Document whatever you used: source and year in the exchange, process or parameter comment (section 5),
and in the scope via `model_info` when it shapes the study.

## 8. Verify before you report

**Building includes verifying.** "Build a model" means a model whose numbers exist and have survived the
checks below — run them after every build that created or restructured a product system, unasked. Skip them
only when the user explicitly ordered structure-only work, and then say that the model is uncalculated and
unreviewed. (A run that skipped them delivered a disposal phase that bought recyclate and a raw-material
process that entered the result at 42 % of its mass — both invisible without the numbers.)

1. Run `check_model_health` and fix what it reports.
2. Calculate with the agreed (recommended) method and sanity-check magnitudes.
3. Show the per-phase contribution, so the user sees where the impact sits.
4. **Read the flows of the leading phase, before you build a single scenario**: `explain_result`
   mode="flows" with `phase` set to the dominant phase. Hold what comes back against your recipe and ask
   the two questions no structural check can:
   - **Is each emission the flow you meant?** A quantity booked on the wrong flow resolves, balances and
     passes every check.
   - **Is any carbon counted twice?** If you booked an emission *and* modelled the process that releases
     it, the same atom is in the result twice.

   One study booked the volatile fraction of a wood stain on fossil CO₂ instead of NMVOC — its carbon was
   counted alongside the oxidation already modelled, a tenth of the result. The health check was clean,
   two scenario comparisons were built on the baseline, and all of it was repeated after the review found
   it. This is the cheapest check of *content* there is, and it belongs here.
5. **Test the assumption the result rests on — before you report it.** Where one phase or one process
   carries more than about half the score, the study is a statement about that single assumption, and a
   single number is the wrong shape for it. Vary it — `edit_scenario` action="create", overriding only
   the parameters that change, then `compare_scenarios` for the lead indicator — and report the
   **spread**: "0.15 kg CO2-Eq, between 0.09 and 0.21 across plausible water-heating routes".
   - Choose what to vary from the contribution, not from a checklist: the parameter behind the dominant
     phase first, then whatever the user flagged as uncertain. Two or three scenarios are a sensitivity
     analysis; ten are a maintenance burden.
   - A dominant figure that is not a parameter yet becomes one first (section 6) — a number typed into an
     exchange, or a constant you derived by hand, cannot be varied. Details: the *Parameters & formulas*
     skill; ranges worth using for end-of-life: the *End-of-life & what-if scenarios* skill.
6. **Get a second opinion: `review_model`, with `code` and `method`**, after every build of a whole
   product system — not after single-value edits. It gathers its own evidence and runs its own hotspot
   analysis, and it is a DIFFERENT model, which is the point: once it caught a wrong background dataset the
   builder kept reading past. Present the findings, act on them, and record the outcomes with
   `resolutions` — the *Critical review* skill has the details.
7. Reference the processes you created with `[Label](prism:process/<code>)` chips.
8. If decisions changed the goal & scope (boundaries, FU, geography, reference year), update it via `model_info`.

**A clean health check is not a correct model.** It sees structure — links that resolve, signs that match,
one reference product, how the phases hang. It cannot see an amount four times too high, a proxy of the
wrong material, an emission on the wrong flow, or a study that answers a different question than the
brief. So it means "nothing structural is broken", never "the number is right", and it is no finding to
report as one. After any change that could move the result, **calculate before and after and account for
the difference**: say what you expected the change to do and check the number did that. A tidy-up that
should have changed nothing and moved the total by 20 % changed the model; a restructure that moved it less
than predicted has probably left half of itself behind.

## 9. Record what you could not resolve, and write the result up as what it is

**Whoever writes the report never sees this conversation.** They get the study metadata, the numbers and
the comments on your processes, exchanges and parameters — that is the whole channel. Most findings have a
home there: a proxy's reasoning in the comment of the exchange that uses it, a figure's source in the
parameter comment. What has
none is the judgement about the *study*, and that is what a reader needs most:

- an **allocation you had to choose** ("the whole shower's hot water is charged to one wash"),
- an **assumption the result turns out to rest on**, once the contribution shows which,
- something **deliberately excluded**, and why,
- **data the user could not supply**, so a figure is a default rather than theirs.

Record these with `model_info` action="set", field `limitations`: a list of `{text, kind, subject}`,
`kind` one of `limitation | assumption | exclusion | data_gap`, each a full sentence a client will read. It
replaces the whole list, so pass the ones that still apply. Do it **as they arise**, not at the end — the
run that discovers a dominant assumption is the run whose round budget ends before it writes anything
down. Three real ones beat ten hedges; the report adds uncertainty, data quality, critical review and
sensitivity on its own, so do not repeat those.

**Never name this software or your own tools in study text** — in **every** field you write: the goal, the
scope, the geography and reference year, the cut-off criteria, both allocation fields, the critical review,
the limitations, the process, exchange and parameter comments, the scenario names and descriptions, and
the people fields (author, organisation, commissioner). All of it is printed in a document a client reads; "Private user (model
commissioned in PrismLCA)" once went into `commissioner` and onto the report's title page. Write what was
*done* and what it means — "the structure was checked for unlinked inputs and sign errors" — never which
button did it; where nobody commissioned the study, say that nobody did. The same goes for
`review_model`, the assistant itself and any model name.

**Write the result up as what it is**: a screening figure resting on named assumptions, with the range
from section 8, step 5 and the assumption that produced it. A dominant assumption left untested is the one
limitation a reviewer finds first. Never call a model complete, correct, verified or validated: you have
checked what you could check, the user knows things you do not, and a confident wrong number costs more
than an honest uncertain one.
