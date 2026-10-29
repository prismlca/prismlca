# Choosing a proxy dataset when the background database has no exact match

Load this when `search_background` returns nothing that truly matches an input (no dataset for the
right product, geography, or technology). A proxy is a *deliberate, documented* substitution — not
a lucky guess. The goal is the least-wrong dataset **and** an honest record of the compromise.

## 0. First make sure you actually need a proxy

- Re-search with different terms (synonyms, the chemical/material name, the service, the CPC
  wording), drop the geography filter, and widen activity type. Most "no match" cases are search
  misses, not real gaps.
<!-- if ecoinvent -->
- In ecoinvent, check whether a **market** (type M) exists even if no specific production route does
  — a market is the correct choice when the supplier/route is unknown (see §2).
<!-- endif -->
<!-- if bafu -->
- BAFU:20XY has **no markets**: its generic datasets are the `…, at plant`, `…, at grid`, `…, supply
  mix` and `…, at regional storage` ones, mostly for CH, some RER/Europe/GLO. Search those before
  declaring a gap.
<!-- endif -->
- Only when a genuine dataset is absent do you proxy.

## 1. Rank proxy strategies — best first

Pick the highest option that applies; each step down costs representativeness.

1. **Same product, different geography.** Same reference product, different region. Prefer, in
   order: a neighbouring/similar region → a broader region (e.g. RER, Europe) → GLO → RoW. This is
   usually the *smallest* error because the technology is identical. Match the geography to the
   study's `geography` field; adjusting the electricity background alone is **not** enough on its
   own (see §4).
2. **Same product, market vs. production** (ecoinvent). If only a market exists, use it (average
   consumption mix). If only a production dataset exists but you need the generic product, a market
   is still preferable when the route is unknown. In BAFU the "supply mix" / "at grid" datasets play
   that role.
3. **Closely related product, same technology family.** A chemically/functionally close sibling
   made by a comparable process (e.g. a similar organic solvent, a similar alloy). For chemicals,
   go from the **most specific** class that has data outward to broader classes — never jump
   straight to a generic "chemical, organic" dataset if a nearer relative exists.
4. **Generic class dataset** (e.g. "chemical production, organic"). Last database resort. These
   carry a large, systematic bias (see §4) — use only for minor inputs and flag it loudly.
5. **Exclude and declare a gap.** If nothing reaches acceptable quality — no proxy and no own
   calculation (below) — it is better to leave the input out and record it explicitly than to fill
   it with a misleading dataset (ILCD rule).

**Building it yourself is an option at every step, not the step after the last.** For an input that
matters you can model the dataset instead of borrowing one: a stoichiometric or mass-balance estimate
of the raw materials plus the energy demand, or a small process from the user's or published
production data. Weigh it against the best proxy you found rather than reaching for it only when the
list runs out. Which wins depends on the process and on what the database holds. A known technology
with a sourced recipe can beat a distant sibling (3), a generic class dataset (4), and sometimes
even more. It loses to a proxy that shares the technology. It needs a source for the reaction or
recipe and for the energy, and it comes out low, because process losses, utilities, yield and
infrastructure are missing (§4). So add what you can of them and record the result as a lower bound.

## 2. Judge similarity on four axes (the representativeness the EF/PEF method scores 1–5)

- **Technological** — same process route, chemistry, energy carriers, scale. The strongest
  predictor: similar technology ⇒ similar inputs and emissions. Different route = weak proxy.
- **Geographical** — same electricity mix, raw-material basis, emission limits, abatement level.
  "Different country, similar grid + similar regulation" is a fair proxy; "different country,
  swap only electricity" is the classic mistake.
- **Temporal** — how old is the dataset relative to the technology today. Degrade the older it is.
- **Reference product & function** — the proxy must deliver the *same function per the same unit*.
  Check the unit and reference product with `get_process_details` before linking.

If none of these is close, say so and prefer building or excluding over a bad match.

## 3. Prefer proxies for SMALL gaps, not whole unknown processes

Similarity-based substitution is reliable when it fills a *small* part of an otherwise-known
system (empirically, accuracy holds when the substituted share is small and degrades fast as it
grows). Proxying a **minor input** is defensible; proxying the **main process** of the study, or
several large inputs at once, is not — escalate to building the dataset or narrowing the scope.

## 4. Known pitfalls and biases — check every time

- **Waste treatment sign.** Substituting one waste dataset for another can change which sign the
  exchange needs, and the name does not tell you: read the provider's reference-product sign with
  `get_process_details` after every such swap. The rule itself lives in the **LCA model building**
  skill (§4) — load it rather than working from memory.
- **Generic/legacy chemical datasets underestimate.** Aggregated or old chemical proxies can
  underestimate climate impact substantially (heat demand under-counted, electricity often
  over-counted; reported gaps up to ~40–45%). Treat a generic-chemical proxy result as a likely
  **lower bound**.
- **Stoichiometric estimates underestimate too** (reported ~35–50% low on GWP for some chemicals),
  because they ignore process losses, utilities and yield. Useful as a floor, not a truth.
- **GLO/RoW may be a relabeled single region.** Many GLO datasets are extrapolated from one
  regional dataset (flagged in the comment). Read the dataset comment before trusting a GLO proxy.
- **A generic name can hide a specific application.** The comment says what the dataset was built
  for; the name never does. `printed wiring board production, surface mounted, unspecified, Pb free`
  is calibrated on "the printed wiring board for **desktop and laptop computer**"; `battery
  production, NiMH, rechargeable` describes "a NiMH battery **for laptop applications** … as used in
  a Fujitsu-Siemens laptop". Both were used for a small garden solar lamp on the same practice run,
  at 44 % and 41 % of the result. **A market will not tell you this** — its comment is boilerplate,
  so read the producer it buys from. `explain_result` lists the biggest contributors you have not
  opened yet (everything above 10 %, plus the top 8 down to 2 %) under `not_yet_inspected`; open
  them before you report.
- **Market group vs. market.** A market *group* aggregates several markets over a larger area —
  don't use it where a specific market is meant, or you blur the geography.

## 5. Document every proxy (non-negotiable)

Guidance (ILCD, PEF) is unanimous: an undocumented proxy is a defect. For each proxy:

- Record **what you substituted, with what, and why** — which axis (§2) you compromised on and
  the expected direction of bias (§4) — in the comment of the exchange that uses the proxy
  (`edit_exchange` with `comment`). The report's inventory and interpretation writers read every
  exchange comment beside its process and input, so a reader's question about this input is
  answered there. Two or three sentences; a longer comment is cut. Only when the whole process is a
  stand-in (its structure taken from another product or technology) does the reasoning go into the
  process description (`edit_process` with `comment`) instead. When the result rests on the proxy,
  say that in the study's `limitations` too (`model_info`, kind `assumption`) — the fact, not the
  reasoning, which stays in the comment.
- Keep proxy use **bounded**: it should not dominate the result. PEF caps proxy datasets at 10% of
  the total score — as a rule of thumb, if proxied inputs drive a top contribution, that is a
  finding to report, not to hide.
- Flag the **quality**: a proxy is lower-quality data; say so plainly in the answer.

## 6. When the choice is material, ask

If two proxies are plausible and the pick changes the outcome (e.g. a regional vs. GLO dataset for
a dominant input, or which chemical sibling to use), use `ask_user` with the concrete candidates
rather than silently choosing. Then run `calculate`/`explain_result` and, if the proxied input is a
hotspot, note its sensitivity in the answer.

## One-line summary

Search harder → rank proxies (same product/other geo > market > near sibling > generic class >
exclude), and weigh building the dataset yourself against the best of them → judge
tech/geo/time/function similarity → prefer small gaps → watch the waste sign and the
underestimation biases → document and bound every substitution.
