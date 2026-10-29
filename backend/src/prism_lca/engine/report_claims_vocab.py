"""The claim gate's language tables — data, deliberately in Python.

Thirteen language-keyed vocabularies (comparators, superlatives, ordinals, denials, …) that
`report_claims` matches chapter prose against. They moved out of that module because ~600 lines of
word lists buried the matchers that read them; they stayed Python rather than JSON because the
entries carry tuple structure and, more importantly, the measured incidents in the comments beside
them — a word list without its "why this word is (not) here" history is the thing that gets
re-broken. `report_claims` re-exports each table under its historical underscore name, so its
matchers, `report_staleness` and the offline word-forms author script read them exactly as before.
"""

from __future__ import annotations

#: Comparison vocabulary per language: (higher-than words, lower-than words).
#: Kept small and unambiguous on purpose — "over" and "under" are excluded because they are far more often
#: prepositions of place or time than comparisons ("over the life cycle", "under the cut-off"). German
#: "über den" is out for exactly that reason and stays out: it is the accusative of *across* ("über den
#: Lebensweg"), not the dative of a comparison, and only "über dem"/"über der" are the latter.
#:
#: This is the one list matched by plain substring (`says_higher`/`says_lower`) rather than through
#: `_mentions`, so it has **no** inflection tolerance at all — and the inflection of a romance
#: comparator sits in the middle of the phrase, where no trailing tolerance would reach it anyway
#: ("supérieures à", "superiores a"). So each gender and number is an entry of its own, and the audit
#: that added them (V212) found the singular masculine was all any of the three had: a French chapter
#: writing "les émissions sont supérieures à celles du scénario A" had its direction checked by
#: nothing, while the German and English sentences next to it were checked.
#:
#: What is still out of reach here, deliberately, is the *attributive* comparative with a noun wedged
#: into it — German "eine höhere Belastung als", French "une charge plus élevée que le scénario A" only
#: reads because the words happen to be adjacent. A substring cannot span the noun, and a gapped
#: pattern would have to guess how far the gap may run; the predicative form ("ist höher als") is what
#: report prose writes when it states a direction, and that one is covered.
COMPARATORS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "en": (
        # "exceed the" and "exceeded" beside "exceeds", not a bare "exceed": a substring of that stem
        # also sits inside *exceedingly*, and "an exceedingly small share" is not a comparison — it
        # would set the direction and let the arithmetic contradict a sentence that claims nothing.
        ("higher than", "greater than", "larger than", "more than", "above the",
         "exceeds", "exceed the", "exceeded"),
        ("lower than", "smaller than", "less than", "below the"),
    ),
    "de": (
        ("höher als", "größer als", "grösser als", "mehr als", "über dem", "über der", "überschreitet"),
        ("niedriger als", "geringer als", "kleiner als", "weniger als", "unter dem", "unter der"),
    ),
    "fr": (
        (
            "supérieur à", "supérieure à", "supérieurs à", "supérieures à",
            "plus élevé que", "plus élevée que", "plus élevés que", "plus élevées que",
            "plus que", "dépasse",
        ),
        (
            "inférieur à", "inférieure à", "inférieurs à", "inférieures à",
            "plus faible que", "plus faibles que", "moins que",
        ),
    ),
    "es": (
        (
            "superior a", "superiores a", "mayor que", "mayores que",
            "más alto que", "más alta que", "más altos que", "más altas que",
            "más que", "supera",
        ),
        (
            "inferior a", "inferiores a", "menor que", "menores que",
            "más bajo que", "más baja que", "más bajos que", "más bajas que",
            "menos que",
        ),
    ),
    "pt": (
        (
            # The contractions are entries of their own: "superiores às da referência" is how the
            # comparison is actually written, and since these are matched as words (see `_says`) the
            # `a` of "superior a" does not reach the `às` of the next one (V213).
            # V213 added the plural contractions only; the singular pair is written just as often
            # ("superior à da referência") and is matched here too.
            "superior a", "superior à", "superior ao", "superior às", "superior aos",
            "superiores a", "superiores às", "superiores aos",
            "maior que", "maiores que",
            "mais elevado que", "mais elevada que", "mais elevados que", "mais elevadas que",
            "mais que", "excede",
        ),
        (
            "inferior a", "inferior à", "inferior ao", "inferior às", "inferior aos",
            "inferiores a", "inferiores às", "inferiores aos",
            "menor que", "menores que",
            "mais baixo que", "mais baixa que", "mais baixos que", "mais baixas que",
            "menos que",
        ),
    ),
}

#: Ordinals that turn a superlative into a *ranked* statement: "the second-largest contributor" is a
#: perfectly correct thing to say about index 1, and flagging it was the checker's first false positive in
#: the field — caught by Nemotron writing exactly that sentence.
#:
#: Matched by `_disarming_ordinal`, which is where the entries' shape is explained. Two things follow
#: from it. Whole words: "weiter" is gone, because *weitere Annahmen* is not an ordinal and matching it
#: switched the blocking rule off in nearly every inventory chapter (V209). And stems: the German
#: entries are the front halves of compounds ("zweitgrößte"), which is why they are not words.
#:
#: Spanish keeps only the apocopated "tercer" — the two characters of inflection carry *tercero* and
#: *tercera* from it. Left uncovered on purpose, because it costs a finding and never a false
#: assertion: ordinals past the fifth ("the sixth largest", "die sechstgrößte"). The German
#: free-standing ordinal is covered in every case measured (V212) — "an zweiter Stelle", "zweiten
#: Ranges" and "die zweitgrößten Beiträge" all reach the stem — which is what the stems buy.
#:
#: An entry that is also an ordinary word is kept, but not here: it is judged by what stands next to
#: it, because that is the only thing that separates the two readings. Portuguese "segundo" is the
#: preposition *according to* as well (`_NOT_AN_ORDINAL`); English "next" and "other" are determiners
#: first, so they moved to `_ORDINALS_BEFORE_SUPERLATIVE`.
ORDINALS: dict[str, tuple[str, ...]] = {
    "en": ("second", "third", "fourth", "fifth"),
    "de": ("zweit", "dritt", "viert", "fünft", "nächst"),
    "fr": ("deuxième", "second", "troisième", "quatrième", "cinquième", "suivant"),
    "es": ("segundo", "segunda", "tercer", "cuarto", "cuarta", "quinto", "quinta", "siguiente"),
    "pt": (
        "segundo", "segunda", "terceiro", "terceira", "quarto", "quarta", "quinto", "quinta",
        "seguinte",
    ),
}

#: Ordinals only in the position where they rank something: directly in front of a superlative.
#:
#: English "next" and "other" are determiners first. "The next largest contributor" and "the other main
#: contributor" are genuine statements about rank 2, but "in other words, the dominant group is X" and
#: "the next chapter discusses the dominant group" are ordinary prose — and as bare entries in
#: `_ORDINALS` all four disarmed the rule that **blocks**. What separates the two readings is the word
#: after: the ranked one puts a listed superlative there, the prose one puts a noun ("words",
#: "chapter"). So these two disarm in that position only, which keeps both ranked wordings and hands
#: the two prose sentences back to the rule. A hyphen counts as the gap, because "the next-largest
#: contributor" is how it is written as often as not.
#:
#: Deliberately not generalised. The romance and German twins ("suivant", "siguiente", "seguinte",
#: "nächst") carry the same double reading — "le chapitre suivant" is no more a rank than "the next
#: chapter" — but they also have a bare *ranked* idiom that English lacks ("an nächster Stelle steht
#: …", where nothing follows but a verb), and none of it has been seen in a report. Narrowing a list
#: that **suppresses** makes a blocking rule fire, so it is done where a sentence was measured and not
#: where one can be imagined. The same holds for the English discourse markers: "Secondly, the
#: dominant group is X" disarms too (measured), and it stays, because the narrowing that would stop it
#: also reaches the free-standing ordinal V212 paid for.
ORDINALS_BEFORE_SUPERLATIVE: dict[str, tuple[str, ...]] = {
    "en": ("next", "other"),
}

#: Words claiming the top of a ranking. Only checked when a ranked index appears in the same sentence
#: (V175) — or, where the sentence carries no figure at all, by `report_staleness.unanchored_claims`
#: once the ranking has changed hands (V206). Both read this list, so a phrasing missing from it is a
#: sentence neither of them can see: the French report of run 16 shipped “le groupe **prépondérant**,
#: l'emballage” after the contribution ranking had flipped, because the word was not here (V208).
#:
#: Fewer entries would do if the tolerance did the rest, but it does not: `_mentions` allows two
#: characters of inflection at the **end** of the whole entry, so "dominate" reaches *dominates* and
#: *dominated* while "dominating" would need its own, and a German case ending inside a phrase is a
#: separate entry too. Folded before matching (`folded`), which is what lets "domine" reach *dominé*
#: and "größte" reach *größten*.
#:
#: Bare superlatives ("largest", "höchste") are in; unqualified nouns are not. "principal" or "premier"
#: alone would fire on ordinary prose — a chapter's *principal* objective, the *first* scenario — so
#: where a language's word for "biggest" doubles as its word for "first" or "main", the thing being
#: ranked is part of the entry ("premier poste", "contributeur principal").
#:
#: How much of a paradigm two characters actually carry is **language-dependent**, and V212 measured
#: the difference: it is most of the German and French paradigm and a third of the Spanish one, so the
#: same list was three lists of different strengths. Two sentences out of a delivered Spanish PDF,
#: both claiming the top for a group that had lost it, both invisible to every rule here — "la fase de
#: uso sigue **dominando** el resultado" (gerund, three characters past *domina*) and "el
#: **predominio** del uso" (the noun, which is not *predominante* at all). The French and German
#: sentences beside them were caught, which is why nobody noticed.
#:
#: So the forms are named, and the verb costs one entry per shape it takes past the tolerance:
#: *domina* carries the finite forms and the singular participle, "dominad" the plural participle
#: ("los resultados están dominados por…"), "dominando" the gerund. What is deliberately **not** done
#: is the one-entry version of all four: `domin` reaches *dominio* (Spanish and Portuguese for
#: *domain*, and "el dominio de aplicación del estudio" is goal-and-scope boilerplate) and *dominical*
#: — a stem that turns a scope chapter into a blocked one. `predomin` has no such neighbour in either
#: language, so there it *is* the right spelling, and it earns the noun (*predominio*, *predomínio*)
#: and the past (*predominó*) with it.
#:
#: Romance plurals of the noun collocations are entries of their own, because the inflection sits in
#: the middle of the phrase where no trailing tolerance reaches it ("mayores contribuyentes",
#: "principaux contributeurs"). English needs none — *contributors* inflects at the end, which the
#: tolerance already covers, and that asymmetry is precisely the language-dependent gap V212 was.
SUPERLATIVES: dict[str, tuple[str, ...]] = {
    "en": (
        "dominant", "dominate", "dominating", "dominance", "predominant", "predominance",
        "largest", "biggest", "greatest", "highest", "main contributor",
        "single largest", "main driver", "top contributor", "leading contributor",
        "primary contributor",
    ),
    "de": (
        "dominant", "dominiert", "dominierend", "dominanz", "vorherrschend",
        "größte", "grösste", "größten", "grösten", "höchste",
        "hauptbeitrag", "haupttreiber", "hauptverursacher", "wichtigste", "bedeutendste",
    ),
    "fr": (
        "dominant", "domine", "dominance", "prépondérant", "prépondérance", "prédominant",
        "prédomine", "prédominance", "plus grand", "plus important",
        "plus élevé", "plus gros", "principal contributeur", "contributeur principal",
        "principaux contributeurs", "contributeurs principaux",
        "premier poste", "premiers postes", "poste principal", "postes principaux",
    ),
    "es": (
        "dominante", "domina", "dominad", "dominando", "preponderante", "preponderancia",
        "predominante", "predomin", "predominando", "mayor contribuyente",
        "mayores contribuyentes", "contribuyente principal", "mayor contribución",
        "mayores contribuciones", "mayor aporte", "mayores aportes", "más grande",
        # The Spanish twin of the Portuguese lemma gap (V216), added by symmetry rather than by
        # sighting: the same two nouns exist here and the same sentence is writable.
        "mayor contribuidor", "mayores contribuidores",
        "más importante", "principal contribuyente", "principales contribuyentes",
        "contribuyentes principales",
    ),
    "pt": (
        "dominante", "domina", "dominad", "dominando", "preponderante", "preponderância",
        "predominante", "predomin", "predominando", "predominância", "maior contribuinte",
        "maiores contribuintes", "contribuinte principal", "contribuintes principais",
        "maior contribuição", "maiores contribuições", "maior contributo", "maiores contributos",
        # A delivered Portuguese report wrote "a embalagem permanece como maior contribuidora" —
        # `contribuinte` and `contribuidor` are different nouns, so no amount of inflection tolerance
        # on the one reaches the other, and the claim went unseen after the ranking had flipped (V216).
        # This is the *lemma* gap: the paradigm tool proposes other forms of a listed word and can
        # never propose a word nobody listed.
        "maior contribuidor", "maiores contribuidores",
        "mais importante", "principal contribuinte", "principais contribuintes",
    ),
}

#: The entries above that are comparatives in disguise. "Le poste A est plus important que le poste B"
#: is a statement about two numbers — the same thing `_VALUE_WORDS` says about "more environmentally
#: friendly than", and the same reason: these wordings are superlatives only with an article in front
#: ("le plus important"), so morphology cannot tell the two apart and the comparison word is the only
#: reliable signal. Without this the gate *refused* an honest two-way comparison and the chapter could
#: not be stored at all (V210).
#:
#: A subset of `_SUPERLATIVES`, entry for entry — the exemption asks whether the word that fired the
#: rule is one of these, not whether the sentence contains a comparison somewhere. That distinction is
#: the whole point: "A dominates, and it is larger than B" both compares and claims the top, and the
#: claim stays checkable.
#:
#: Only bare comparative adjectives are here. The noun collocations ("mayor contribución", "maior
#: contribuinte") are ambiguous in exactly the same way, but they are also how both languages spell the
#: plain superlative, and exempting a phrase that common would cost more findings than it saves.
#: English and German need no entries: their superlatives are superlative in form ("largest",
#: "größte"), and "larger"/"größer" do not match them.
#: `plus élevé`, `plus gros` and `más importante` were held back twice — once because they would have
#: blocked honest comparisons, once because the exemption did not exist yet. They land here on arrival,
#: which is the point of writing the exemption first: the coverage a language needs for "this is the
#: biggest" no longer costs a refusal for "A is bigger than B" (V211).
COMPARATIVE_SUPERLATIVES: dict[str, tuple[str, ...]] = {
    "fr": ("plus grand", "plus important", "plus élevé", "plus gros"),
    "es": ("más grande", "más importante"),
    "pt": ("mais importante",),
}

#: Causal *connectives*. Reported, never blocked: LCA prose needs them, and the data cannot settle them.
#:
#: Deliberately not "causes", "verursacht", "responsible for" and their siblings. Those read as causal but
#: in an LCA are statements of result — "the bag causes 0.119 kg CO2-eq", "the process responsible for
#: 51.9 %" — and including them made the note fire on almost every chapter. A remark that appears every
#: time carries no information.
#:
#: Every tense of the verb is an entry, because the tolerance sits at the **end of the whole entry**
#: and the inflection of a causal connective sits in the middle of it: "leads to" carries no other
#: form at all, not *lead to*, not *led to*, not *leading to* — the two characters it may grow come
#: after the *to* (V212). German pays the same way: "führt zu" does not reach the plural *führen zu*,
#: and the passive is written with *von* as often as with *durch*.
#:
#: Left uncovered on purpose, because it is vocabulary rather than morphology and a missed note costs
#: nothing: "owing to", "attributable to", "à cause de", "du fait de", "wegen", "por lo que".
CAUSAL: dict[str, tuple[str, ...]] = {
    "en": (
        "because", "driven by", "due to", "lead to", "leads to", "leading to", "led to",
        "as a result of",
    ),
    "de": ("weil", "getrieben durch", "getrieben von", "aufgrund", "führt zu", "führen zu", "infolge"),
    "fr": ("parce que", "en raison de", "entraîne"),
    "es": ("porque", "debido a", "conduce a", "conducen a"),
    "pt": ("porque", "devido a", "conduz a", "conduzem a"),
}

#: Absolute value judgements. An LCA reports indicator results; "environmentally friendly" is not one of
#: them, and no data in the report supports it. Reported, never blocked — the word can appear inside a
#: quotation from a client's brief.
#:
#: The **comparative** is fine and deliberately allowed ("A is more environmentally friendly than B" is a
#: statement about two numbers): a match is dropped when the sentence goes on to compare with
#: "than"/"als"/"que"/"do que". German cannot be resolved by morphology here — "umweltfreundlicher
#: Prozess" is a positive form and "umweltfreundlicher als" a comparative, same word — so the comparison
#: word is the only reliable signal.
#:
#: French "propre" is listed only in collocations, because on its own it means "own" far more often than
#: "clean": in an earlier modelling session every single hit was "des estimations propres" (our own estimates) or
#: "leurs unités propres" (their own units), seven notes and not one of them true. "propre" carries the
#: value judgement only next to the thing being praised, so the thing is part of the entry. `_mentions`
#: allows inflection at the *end* of an entry only, so each plural is a listed entry of its own rather
#: than a suffix. Not covered, deliberately: an adverb wedged into the phrase ("une énergie très propre")
#: and any noun outside this list — a word list that chases every French noun is how a note stops being
#: read, and the missed sentence costs an advisory, not a wrong report. "plus propre" stays a single entry
#: on purpose: `_THAN` disarms it as soon as the sentence actually compares, so it fires on the dangling
#: "plus propre" of marketing prose and keeps quiet on "plus propre que le scénario A".
#:
#: French "vert" and German "grün" are listed the same way, and for the same measured reason (V207).
#: Bare, they match two of the commonest words in a report that is boasting about nothing at all:
#: `\bvert\w{0,2}\b` matches **"en vertu de la norme ISO 14044"** and "les espaces verts",
#: `\bgrün\w{0,2}\b` matches **"die Gründe für die Abweichung"** — sentences a goal-and-scope chapter
#: writes as a matter of course. The French "point vert" (the recycling mark) is a third. German pays
#: for this in entries, because its case ending sits at the front of the phrase where no tolerance
#: reaches it: "mit grünem Strom" needs a third entry beside "grüner Strom" and "grünen Strom". Left
#: uncovered on purpose: the genitive and the plural of the rarer collocations, and any noun outside
#: the list.
#:
#: Spanish and Portuguese keep the bare "verde", because neither defect is there. The tolerance cannot
#: reach a different word — *verdad*/*verdade* part company inside the two characters it allows — and
#: unlike "propre" or "vertu" the word has no second, everyday meaning. What the bare word still
#: catches is the marketing adjective on a noun nobody predicted; what it costs is a note on a proper
#: name ("el Pacto Verde Europeo"), and a note is not a refusal.
#: The **superlative degree** is a separate entry in every language, because that is where the boast
#: actually lives and the tolerance stops one character short of it: "green" reaches *greener* and not
#: *greenest*, "umweltfreundlich" reaches *umweltfreundlicher* and not *umweltfreundlichste* (V212).
#: The romance **feminine** is an entry too, for the same arithmetic — *ecológica* is not two
#: characters away from *ecológico* but a different last letter, so half of every Spanish and
#: Portuguese adjective was unreachable while the masculine was covered. The price is paid where it is
#: cheapest: "limpia"/"limpa" also reach the infinitive *limpiar*/*limpar*, so "limpiar los datos"
#: earns a note — and a note is not a refusal, while "una solución limpia" going unseen is the boast
#: this rule exists for. The nouns *limpieza*/*limpeza* stay out of reach, which is how data cleaning
#: is usually written.
#:
#: What stays out is the noun that names the discipline: "sustainability", "Nachhaltigkeit",
#: "sostenibilidad". A goal-and-scope chapter writes "the sustainability assessment follows ISO 14040"
#: as a matter of course, and a note that fires on every report is one nobody reads. The adverb
#: ("sustainably produced") is a claim and is in.
#:
#: English "clean" is the one entry here whose degrees are **spelled out** instead of grown by the
#: tolerance, and `_NO_INFLECTION` is where that is explained.
VALUE_WORDS: dict[str, tuple[str, ...]] = {
    "en": (
        "environmentally friendly", "eco-friendly", "environmentally sound", "green", "greenest",
        "sustainable", "sustainably",
        "clean", "cleaner", "cleanest", "harmless", "environmentally better",
    ),
    "de": (
        "umweltfreundlich", "umweltfreundlichste", "umweltschonend", "ökologisch sinnvoll",
        "nachhaltig", "nachhaltigste",
        "sauber", "sauberste", "unbedenklich", "ökologisch besser",
        "grüner strom", "grünen strom", "grünem strom", "grüne energie", "grüner energie",
        "grüner wasserstoff", "grünen wasserstoff", "grüne technologie", "grünes produkt",
        "grüne lösung", "grüne alternative",
    ),
    "fr": (
        "écologique", "respectueux de l'environnement", "respectueuse de l'environnement",
        "durable", "inoffensif", "inoffensive",
        "plus propre", "énergie propre", "énergies propres", "technologie propre", "technologies propres",
        "produit propre", "produits propres", "procédé propre", "procédés propres",
        "solution propre", "solutions propres",
        "énergie verte", "énergies vertes", "électricité verte", "technologie verte",
        "technologies vertes", "produit vert", "produits verts", "solution verte", "solutions vertes",
    ),
    "es": (
        "ecológico", "ecológica", "respetuoso con el medio ambiente",
        "respetuosa con el medio ambiente", "verde", "sostenible", "limpio", "limpia",
        "inocuo", "inocua",
    ),
    "pt": (
        "ecológico", "ecológica", "respeitador do ambiente", "respeitadora do ambiente",
        "verde", "sustentável", "sustentáveis", "limpo", "limpa", "inócuo", "inócua",
    ),
}

#: Neutrality claims. Their own rule because they are not loose wording but a claim with a definition
#: (offsetting, scope, permanence) that an LCA result cannot carry on its own — the author's instruction
#: was that these belong in very few reports at all. Flagged even in the comparative.
#:
#: The **noun** is an entry beside the adjective in every language, because the tolerance cannot reach
#: it and the noun is how the claim is usually made: *carbon neutrality*, *Klimaneutralität*,
#: *neutralité climatique* are three characters or more past *carbon neutral*, *klimaneutral*,
#: *climatiquement neutre* — a Spanish or Portuguese report claiming "neutralidad de carbono" was seen
#: by nothing (V212). The romance feminine is an entry too ("neutra en carbono"), same arithmetic as
#: `_VALUE_WORDS`.
#:
#: "co₂-neutral" is gone rather than added to: `folded` runs NFKD, which turns the subscript into a
#: plain 2, so the entry matched exactly the same text as "co2-neutral" — and the note names the
#: entries it matched, so a chapter writing it once was told about two words it had not used.
#:
#: Left uncovered on purpose, as vocabulary: the romance renderings of *net zero* ("cero neto", "zéro
#: net", "zero líquido"), which are idiom rather than inflection and want a native reading before they
#: go in — reported rather than guessed (V212).
NEUTRALITY_WORDS: dict[str, tuple[str, ...]] = {
    "en": (
        "climate neutral", "climate-neutral", "climate neutrality", "carbon neutral",
        "carbon-neutral", "carbon neutrality", "net zero", "net-zero",
    ),
    "de": (
        "klimaneutral", "klimaneutralität", "co2-neutral", "co2-neutralität",
        "kohlenstoffneutral", "netto-null",
    ),
    "fr": (
        "neutre en carbone", "neutres en carbone", "neutralité carbone", "neutralité climatique",
        "climatiquement neutre",
    ),
    "es": (
        "neutro en carbono", "neutra en carbono", "neutralidad climática",
        "neutralidad de carbono", "climáticamente neutro", "climáticamente neutra",
    ),
    "pt": (
        "neutro em carbono", "neutra em carbono", "neutralidade climática",
        "neutralidade de carbono", "climaticamente neutro", "climaticamente neutra",
    ),
}

#: Words that turn an adjective into a comparison of two computed values.
#:
#: The French entry carries the ASCII apostrophe and reaches "qu’une" through `_APOSTROPHES`. It has to:
#: a model writes the typographic one, and without that fold the exemption missed every French
#: comparison there is — so the value-judgement rule reported "plus propre qu’une autre solution", a
#: genuine comparison, as a boast (V207).
THAN: dict[str, tuple[str, ...]] = {
    "en": ("than",),
    "de": ("als",),
    "fr": ("que", "qu'"),
    "es": ("que",),
    "pt": ("que", "do que"),
}

#: Spans that look like a listed ordinal and are not one. Written against the **folded** sentence, so
#: accents are already gone; blanked before matching, never dropped, so every other offset survives.
#:
#: *A preposition.* Portuguese `segundo` is "according to" as well as "second", and "segundo a norma ISO
#: 14044" is not a statement about rank — it disarmed a rule that blocks. The preposition is followed by
#: a determiner, the ordinal by a noun or a superlative, so the next word separates them (V213). Spanish
#: is unaffected: there the preposition is `según`.
#:
#: *A fraction.* A fraction is a quantity, not a rank, and three of the ordinal entries reach one:
#: German `dritt`/`viert`/`fünft` grow into *Drittel*/*Viertel*/*Fünftel* inside the two characters of
#: tolerance, so "Ein Drittel entfällt auf den dominierenden Beitrag {{…groups.1…}}" — a sentence that
#: claims the top for a member that does not hold it — was silent. German is free of charge: those three
#: nouns are never ordinals, so the whole word is blanked and no reading is lost.
#:
#: Spanish and Portuguese pay a little, and it is worth it. There the ordinal *is* the ambiguous word
#: (`cuarto`/`quarto` is "fourth", "a quarter" and "a room"), so the discriminator has to be the
#: indefinite article, which is the fraction's own: "un cuarto del impacto corresponde al grupo
#: dominante" is a quantity, "el cuarto grupo" a rank. What that costs is the ordinal with an
#: indefinite article — "un cuarto grupo es el dominante" — and that is the cheaper error, because a
#: sentence numbering a group fourth *and* calling it dominant is wrong prose whichever rule sees it.
#: The plural is free like the German nouns ("tres cuartos del total"): no language ranks in plural
#: ordinals. Left alone as unmeasured and rarer: `quinto`/`quinta` in the same fraction reading.
NOT_AN_ORDINAL: dict[str, tuple[str, ...]] = {
    "de": (r"\b(?:drittel|viertel|f[uü]nftel)\w{0,2}\b",),
    "es": (r"\b(?:un|una)\s+cuart[oa]\b", r"\bcuart[oa]s\b"),
    "pt": (
        r"\bsegundo(?=\s+(?:a|o|as|os|ao|aos|um|uma)\b)",
        r"\b(?:um|uma)\s+quart[oa]\b",
        r"\bquart[oa]s\b",
    ),
}

#: Which rank each listed ordinal names, as a zero-based index. Strictly a *reading* of `_ORDINALS`
#: and `_ORDINALS_BEFORE_SUPERLATIVE` — a test asserts every key here is an entry of one of them, so
#: this can never become a second, wider ordinal vocabulary. What it adds is the one thing those lists
#: do not carry: an ordinal disarms by being *an* ordinal, while a declaration needs the number.
#:
#: The entries deliberately **missing** are the ones with no number to give: German "nächst", French
#: "suivant", Spanish "siguiente", Portuguese "seguinte" and English "next"/"other" all mean *the one
#: after this one*, which is a rank only relative to something the sentence chose elsewhere. They go on
#: disarming the blocking rule exactly as before, and a sentence carrying one gets no suggestion —
#: `_declared_rank` reads a missing entry as "the ordinals do not agree on one rank" and falls silent.
#: Same for ordinals past the fifth, which `_ORDINALS` does not carry either (see the note there).
ORDINAL_INDEX: dict[str, dict[str, int]] = {
    "en": {"second": 1, "third": 2, "fourth": 3, "fifth": 4},
    "de": {"zweit": 1, "dritt": 2, "viert": 3, "fünft": 4},
    "fr": {"deuxième": 1, "second": 1, "troisième": 2, "quatrième": 3, "cinquième": 4},
    "es": {"segundo": 1, "segunda": 1, "tercer": 2, "cuarto": 3, "cuarta": 3,
           "quinto": 4, "quinta": 4},
    "pt": {"segundo": 1, "segunda": 1, "terceiro": 2, "terceira": 2, "quarto": 3, "quarta": 3,
           "quinto": 4, "quinta": 4},
}

#: Words that make the superlative next to them *not* a claim to the top. A suppressor, read by the
#: advisory and by nothing else (`_denied_spans` has exactly one caller) — which is the whole safety
#: argument, because the rule that **blocks** goes on judging these sentences byte for byte as before.
#: Getting a denial wrong here costs a note that does not appear; getting one wrong in the blocking
#: rule would make a refusal fire or fall silent, and that is what `next`/`other` cost in V224.
#:
#: Two kinds, and they fail the same way. A **denial**: "Kein Einzelprozess dominiert", "aucun groupe
#: ne domine", "ningún proceso domina por sí solo". A **hedge**, which is the sneakier one: "one of the
#: largest contributors", "l'un des principaux contributeurs" — *one of* the main ones is true of index
#: 0 and of index 3 alike, so a declaration on index 0 asserts more than the sentence does.
#:
#: Written as patterns against the **folded** sentence, so accents are already gone ("não" is `nao`,
#: "ningún" is `ningun`) and the apostrophe is ASCII ("l'un des" reaches "l’un des"). The trailing
#: `\w{0,2}` on the pronominal negators is the same tolerance the rest of the module allows, and it is
#: what carries a paradigm whose ending is the whole difference: `kein` reaches *keine/keinen/keiner*,
#: `ningun` reaches *ninguna/ninguno*, `nenhum` reaches *nenhuma*.
#:
#: All five languages, including the two nothing fired on in the corpus (Portuguese and, for the
#: hedges, German) — the point of the rule is that a denial in any report language is not told to
#: declare a rank, and a language left out would get the wrong advice rather than none.
#:
#: What is deliberately *not* here: "rather than", "instead of", "au lieu de". They read like denials
#: and they were measured not to be — "the dominance of the raw-materials phase … spread across several
#: ingredient supply chains **rather than** concentrated in a single process" denies concentration
#: *inside* the leading phase while asserting that phase's lead, and the same shape appears in the
#: conclusions chapter beside it. Both are correct advisories today and both would have been silenced.
DENIALS: dict[str, tuple[str, ...]] = {
    "en": (
        r"\bno\b", r"\bnot\b", r"\bnone\b", r"\bneither\b", r"\bnor\b", r"\bnever\b", r"\bnothing\b",
        r"\bone of the\b", r"\bamong(?:st)? the\b",
    ),
    "de": (
        r"\bkein\w{0,2}\b", r"\bnicht\b", r"\bnichts\b", r"\bweder\b", r"\bniemals\b",
        r"\bein(?:er|es|e) der\b",
    ),
    "fr": (
        r"\bne\b", r"\bn'", r"\baucun\w{0,2}\b", r"\bpas\b", r"\bni\b",
        r"\bl'un(?:e)? des\b", r"\bun(?:e)? des\b", r"\bparmi les\b",
    ),
    "es": (
        r"\bno\b", r"\bningun\w{0,2}\b", r"\bni\b", r"\bnada\b",
        r"\bun[oa] de l[oa]s\b", r"\bentre l[oa]s\b",
    ),
    "pt": (
        r"\bnao\b", r"\bnenhum\w{0,2}\b", r"\bnem\b",
        r"\bum dos\b", r"\buma das\b", r"\bentre [oa]s\b",
    ),
}

#: Spans that look like a denial and affirm instead. Blanked before the denials are matched, the same
#: mechanic `_NOT_AN_ORDINAL` uses for a fraction, and for the same reason: the phrase is not a
#: negation at all, so the cleanest thing is for the matcher never to see it.
#:
#: "not only X but also Y" affirms X, and a report on disk writes it — "the naphtha market is **not
#: only** close to a fifth of the whole roll but the overwhelming component of the leading hotspot".
#: There it happens to stand in a clause of its own, so nothing was suppressed either way; the guard is
#: here because it is the one construction in which the negator and the claim are the same clause by
#: design. The contrastive twin needs nothing: "nicht von der Distribution, **sondern** von der
#: Produktion dominiert" is a correct advisory in the corpus, and the comma the languages require
#: before *sondern*/*sino*/*mais* already ends the clause.
NOT_A_DENIAL: dict[str, tuple[str, ...]] = {
    "en": (r"\bnot only\b", r"\bnot just\b", r"\bnot merely\b"),
    "de": (r"\bnicht nur\b", r"\bnicht bloß\b"),
    "fr": (r"\bnon seulement\b",),
    "es": (r"\bno solo\b", r"\bno unicamente\b"),
    "pt": (r"\bnao apenas\b", r"\bnao so\b", r"\bnao somente\b"),
}

