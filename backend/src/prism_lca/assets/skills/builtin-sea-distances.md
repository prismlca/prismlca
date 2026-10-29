# Sea freight distances

Ocean legs are usually the longest distance in a product system and one of the least documented.
Nobody publishes the route their supplier's container took, so the figure is an assumption — and
an assumption is only worth what its statement is worth. This skill gives you planning distances
so you do not have to guess an order of magnitude, and tells you what to write down beside them.

## The unit is kilometres

Both background databases bill sea freight in **tonne-kilometres**: in ecoinvent `transport,
freight, sea, container ship` (and the bulk/tanker variants), in BAFU:20XY `Transport, transoceanic
freight ship` — each has a reference flow of one tkm. So the exchange amount is

    tonnes carried x kilometres sailed

and everything below is in **kilometres, port to port**. Never put a nautical-mile figure into that
amount, and never use a straight-line or flight distance: a ship goes around continents, and on the
long routes the sailed distance is 1.3 to 2 times the great-circle one.

<!-- if distances -->
## Look the route up first

Use `distances` with mode="sea" for the actual port pair: it returns the sailed distance over the
shipping-lane network, names the passages (Suez, Panama, the Cape) and reports separately how far each
inland place lies from its port — that inland leg is a road or rail leg of its own, not part of the
ship's kilometres. Look every sea leg up this way; the tables below are then the plausibility check
for what it returns. Never add a corridor value on top of a looked-up route.

The tool's km may already carry the GLEC sea factor (sailed distance x 1.15, GLEC Framework v3.2
after Clean Cargo: real container routes run about 15 % longer than the shortest one); its
"adjustment" says whether it does, and "raw_km" is the shortest route before it. The tables below are
shortest routes, so compare them with raw_km, and use km for the exchange. The road legs to and from
the ports come back separately under "access" — book them as road transport of their own.
<!-- endif -->
A table value below is a shortest route with no factor in it: write in the process comment whether
the study applies one (GLEC Framework v3.2: sailed distance x 1.15, after Clean Cargo).

## Planning distances

Round numbers on purpose. They are the middle of what several public route calculators report for
the busiest port pairs of each corridor, rounded coarsely — good to roughly +/-10 %, which is far
inside the uncertainty of not knowing the port, the service or the year. **Do not present them as
exact**, and do not attribute them to a source: they are conventions, not measurements.

### East Asia to Northern Europe
| Corridor | via Suez | around the Cape |
|---|---|---|
| China / Korea / Japan - Rotterdam, Hamburg, Antwerp | **20 000 km** | **26 000 km** |
| Vietnam - Northern Europe | **18 000 km** | ~24 000 km |
| Singapore / Malaysia - Northern Europe | **16 000 km** | **22 000 km** |

**Which one you use is a decision you must record.** Since late 2023 a large share of Asia-Europe
container traffic has been routed around the Cape of Good Hope instead of through the Suez Canal,
and the detour is roughly a third more distance on the China run. A study that silently assumes
Suez understates the leg; one that silently assumes the Cape overstates it for the years before.
Name the assumption in the process comment and make the distance a parameter, so the scenario
"the other routing" costs one line.

<!-- if distances -->
**With `distances`:** its shortest route goes through Suez. Ask for the other routing with
`via="cape"` on the pair — the tool then avoids Suez and Panama and sails round Africa — instead of
adding anything to the Suez figure yourself.
<!-- endif -->
For a table value, these are the rounded detours the shipping-lane network gives for going round the
Cape instead of through Suez; add one to a Suez figure when the study assumes the Cape:

| Relation | Detour round the Cape |
|---|---|
| East / South-East Asia – Northern Europe | **+6 000 km** |
| India (west coast) / Arabian Gulf – Northern Europe | **+8 500 km** |
| East Asia – Mediterranean ports | **+9 000 km** |

Not one flat number: the further west the origin and the further into the Mediterranean the
destination, the longer the way round Africa compared with the canal.

### Other corridors
| Corridor | km |
|---|---|
| India (west coast) - Northern Europe, via Suez | **12 000** |
| Arabian Gulf - Northern Europe, via Suez | **12 000** |
| Eastern Mediterranean / Turkey - Northern Europe | **4 000** |
| Baltic - Rotterdam / Hamburg | **1 500** |
| China - US West Coast | **11 000** |
| China - US East Coast, via Panama | **20 000** |
| Northern Europe - US East Coast | **6 500** |
| Northern Europe - US West Coast, via Panama | **16 000** |
| Northern Europe - Caribbean / Colombia's north coast | **9 000** |
| Northern Europe - South Africa | **15 000** |
| Northern Europe - Australia (liner service) | **25 000** |

### South America
The continent needs four rows, not one: the east coast is twice as far at its southern end as at
Santos, and anything on the Pacific side goes through Panama.

| Corridor | km |
|---|---|
| Northern Europe - Brazil, north-east and Santos | **10 000** |
| Northern Europe - Rio de la Plata (Buenos Aires, Montevideo) | **13 000** |
| Northern Europe - Peru (Callao), via Panama | **12 000** |
| Northern Europe - Chile (Valparaiso, San Antonio), via Panama | **14 000** |
| East Asia - South America west coast | **17 000** |
| East Asia - Brazil | **21 000** |

Australia is the loosest of these: a direct routing is nearer 21 000 km, while the scheduled
services that actually carry containers call at Asian hubs on the way and run to 28 000. If the
Australian leg matters to your result, say which of the two you meant.

## No corridor fits: the size classes

For a route none of the rows covers, these are the bands an ocean leg falls into. They are **not** a
substitute for looking the route up — they are what tells you whether the number you looked up is
plausible, and what to say if you truly cannot look it up.

| Class | km | What it looks like |
|---|---|---|
| One sea basin | 1 000 - 4 000 | Baltic, North Sea, Mediterranean end to end |
| One ocean, mid-latitudes | 6 000 - 9 000 | Northern Europe to the US East Coast or the Caribbean |
| One ocean, into the southern hemisphere | 10 000 - 15 000 | Europe to Brazil, to the Plate, to South Africa |
| One canal, half the globe | 12 000 - 17 000 | Europe to India, the Gulf, the US West Coast, South East Asia via Suez |
| Two hemispheres, one canal | 18 000 - 22 000 | Europe to East Asia via Suez, Asia to the US East Coast |
| Around a cape, or antipodal | 22 000 - 28 000 | Europe to East Asia around the Cape, Europe to Oceania |

A figure that lands two classes away from where the geography puts it is wrong, and the usual cause
is that a great-circle or flight distance got in by mistake.

## What the standards say about this

Two things worth knowing, because they are what a reviewer will ask.

**ISO 14083 names the distance you are supposed to use.** For sea it is the *shortest feasible
distance* — the route a ship can actually sail — and not the great-circle distance, which the
standard reserves for air freight. Everything in this skill is of the first kind.

**The EU Product Environmental Footprint method carries a default for the case where you know
nothing at all.** Where the supplier is outside Europe and neither the country nor the route can be
established, it allows 1 000 km by lorry plus 18 000 km by ship. Its value is that it is *citable*:
in a PEF-aligned study it is defensible where an invented figure is not.

**It is a floor, not a ceiling, and it does not outrank knowledge.** If you know the origin — and a
corridor in this skill means you do — the corridor is the better figure and PEF does not ask you to
throw it away; its default exists for the supplier you cannot identify. Reaching for 18 000 km on a
shipment you know comes from Chile replaces a 14 000 km answer with a worse one and calls it
compliance. Use the default only where the corridor question genuinely has no answer, and say in the
comment which of the two you used and why.

## How to use one

1. **Pick the corridor, not the port**, when the figure comes from these tables. They are corridor
   values; guessing at an exact port pair to choose between rows buys precision the rest of the model
   does not have — the supplier's port is usually unknown anyway.
2. **Make it a parameter** — name it for the leg, e.g. transport_km_sea — never a number inside a
   formula. It is an assumption, so it belongs where assumptions are printed and can be varied.
3. **Write the routing into the comment**: corridor, canal or cape, and that the figure is a
   planning value rather than a measured route. The inventory chapter prints exactly this.
4. **Add the inland legs separately.** These are port to port. Factory-to-port and port-to-customer
   are road or rail legs of their own, and on a short sea route they can be the larger share.

## Your corridor is not in the table

Then it is not in the table. Do not stretch the nearest line to fit: Chile to Northern Europe is not
"about Brazil", and a corridor invented by analogy is a number with no provenance sitting in a
parameter table that says every row is an assumption the study rests on.
<!-- if distances -->
Look the port pair up with `distances`.
<!-- endif -->
<!-- if web -->
On the web, the route calculators are free and the question takes one search.
<!-- endif -->
Where you cannot look it up, say in the comment that the distance is an unverified estimate and how
wide you think the band is.
<!-- if web -->

## When a web lookup is worth it

Look the route up on the web even for a corridor in the table when the ocean leg carries a real share
of the result and the ports are known — a heavy product, a short supply chain, or a study whose whole
question is the transport. For everything else the table above is closer to the truth than the effort
of a lookup suggests, because the port pair itself is a guess.
<!-- endif -->
