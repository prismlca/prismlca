/**
 * Short reference blurbs for the LCIA method families, shown next to the indicator picker.
 * Matched by a pattern on the method's own name (its acronym or full title, at word boundaries),
 * so every version and every importer's spelling maps to one entry: "EF v3.0", "EF v3.1 no LT",
 * "EF 3.1" alike. Nothing here depends on which database the methods came from — Brightway's own
 * default set and an ecoinvent LCIA import both resolve, and a family nobody wrote an entry for
 * simply shows none. Facts are concise, widely-documented properties of each method; the URL
 * points to the method's developers.
 */
export interface MethodInfo {
  name: string
  url?: string
  text: string
  facts: string[]
}

interface Entry extends MethodInfo {
  pattern: RegExp
}

// Order matters: more specific patterns first ("EF v3.1 EN15804" is an EN 15804 set, not EF).
const ENTRIES: Entry[] = [
  {
    pattern: /\bEN\s?15804\b/i,
    name: 'EN 15804 +A2',
    url: 'https://eplca.jrc.ec.europa.eu/EnvironmentalFootprint.html',
    text: 'Impact indicators required by the European construction-EPD standard EN 15804+A2; the impact-category set mirrors the EF method.',
    facts: [
      'For construction EPDs (Type III)',
      'Core + additional indicators, resource use, waste & output flows',
      'Aligned with EF v3.x characterisation'
    ]
  },
  {
    pattern: /\bEF\s?v?\d|\bEnvironmental Footprint\b/i,
    name: 'Environmental Footprint (EF)',
    url: 'https://eplca.jrc.ec.europa.eu/EnvironmentalFootprint.html',
    text: 'The EU-recommended LCIA method underpinning the Product/Organisation Environmental Footprint (PEF/OEF), maintained by the European Commission JRC.',
    facts: ['16 impact categories', 'Basis for EU PEF / OEF', 'Ships normalisation & weighting factors']
  },
  {
    pattern: /\bReCiPe\b/i,
    name: 'ReCiPe 2016',
    url: 'https://www.rivm.nl/en/life-cycle-assessment-lca/recipe',
    text: 'Harmonised midpoint-and-endpoint method (successor to CML and Eco-indicator 99), by RIVM, Radboud University, Leiden CML and PRé.',
    facts: [
      '18 midpoint categories',
      '3 endpoints: human health, ecosystems, resources',
      'Perspectives I / H / E'
    ]
  },
  {
    pattern: /\bCML\b/i,
    name: 'CML-IA (Leiden)',
    url: 'https://www.universiteitleiden.nl/en/research/research-output/science/cml-ia-characterisation-factors',
    text: 'Classic problem-oriented midpoint method from the Institute of Environmental Sciences (CML), Leiden University.',
    facts: [
      'Midpoint only',
      'Long-established baseline (since 2001)',
      'e.g. GWP, acidification, eutrophication'
    ]
  },
  {
    pattern: /\bIPCC\b/i,
    name: 'IPCC (climate change)',
    url: 'https://www.ipcc.ch/',
    text: 'Global Warming Potential characterisation factors from the IPCC Assessment Reports — climate change only, not a full LCIA method.',
    facts: ['Climate change only', 'GWP 20 / 100-year horizons', 'AR5 (2013) / AR6 (2021)']
  },
  {
    pattern: /\bCExD\b|\bcumulative exergy\b/i,
    name: 'Cumulative Exergy Demand (CExD)',
    url: 'https://doi.org/10.1065/lca2006.11.282',
    text: 'Total exergy (available energy) of all resources withdrawn from nature over the life cycle.',
    facts: ['Exergy in MJ', 'Extends CED to material resources']
  },
  {
    pattern: /\bCED\b|\bcumulative energy demand\b/i,
    name: 'Cumulative Energy Demand (CED)',
    url: 'https://doi.org/10.1007/s11367-015-0897-4',
    text: 'Total primary energy withdrawn from nature over the life cycle (renewable + non-renewable), based on VDI 4600.',
    facts: ['Primary energy in MJ', 'Renewable & non-renewable', 'Per VDI 4600']
  },
  {
    pattern: /\becological scarcity\b|\bUBP\b/i,
    name: 'Ecological Scarcity (UBP)',
    url: 'https://www.bafu.admin.ch/bafu/en/home/topics/economy-consumption/economy-and-consumption--publications/publications-economy-and-consumption/eco-factors-switzerland.html',
    text: "Swiss 'Method of Ecological Scarcity': distance-to-target weighting against Swiss policy targets, aggregated to a single eco-point score.",
    facts: ['Single score in eco-points (UBP)', 'Distance-to-target weighting', 'Swiss policy targets']
  },
  {
    pattern: /\becological footprint\b/i,
    name: 'Ecological Footprint',
    url: 'https://www.footprintnetwork.org/',
    text: 'Expresses resource use and CO₂ emissions as the biologically productive land/sea area required (global hectares).',
    facts: ['Global hectares (gha)', 'Includes a carbon land demand']
  },
  {
    pattern: /\becosystem damage potential\b/i,
    name: 'Ecosystem Damage Potential',
    text: 'Land-use impact indicator expressing damage to ecosystems (e.g. potential species loss) from occupation and transformation.',
    facts: ['Land use / biodiversity', 'Endpoint-type indicator']
  },
  {
    pattern: /\bIMPACT\s?World\b/i,
    name: 'IMPACT World+',
    url: 'https://www.impactworldplus.org/',
    text: 'Globally regionalised midpoint-and-endpoint method, merging IMPACT 2002+, LUCAS and EDIP.',
    facts: ['Regionalised characterisation', 'Midpoint + endpoint (human health, ecosystem quality)']
  },
  {
    pattern: /\bIMPACT\s?2002\b/i,
    name: 'IMPACT 2002+',
    url: 'https://doi.org/10.1007/BF02978505',
    text: 'Combined midpoint/damage method from EPFL, linking 14 midpoint categories to four damage categories.',
    facts: ['Midpoint + endpoint', 'Damage: human health, ecosystem quality, climate change, resources']
  },
  {
    pattern: /\bEDIP\b/i,
    name: 'EDIP 2003',
    url: 'https://www2.mst.dk/udgiv/publications/2005/87-7614-581-6/html/indhold_eng.htm',
    text: 'Danish midpoint method from the Technical University of Denmark, with spatially differentiated factors for European regions.',
    facts: ['Midpoint', 'Spatially differentiated (European regions)']
  },
  {
    pattern: /\bTRACI\b/i,
    name: 'TRACI (US EPA)',
    url: 'https://www.epa.gov/chemical-research/tool-reduction-and-assessment-chemicals-and-other-environmental-impacts-traci',
    text: "US EPA's Tool for the Reduction and Assessment of Chemicals and Other environmental Impacts — midpoint method with US-average factors.",
    facts: ['US-specific characterisation', 'Midpoint']
  },
  {
    pattern: /\bUSEtox\b/i,
    name: 'USEtox',
    url: 'https://usetox.org/',
    text: 'UNEP-SETAC scientific-consensus model for human-toxicity and freshwater-ecotoxicity characterisation factors.',
    facts: ['Human tox (CTUh) & ecotox (CTUe)', 'UNEP-SETAC consensus model']
  },
  {
    pattern: /\bEPS\s?\d{4}/i,
    name: 'Environmental Priority Strategies (EPS)',
    url: 'https://www.ivl.se/',
    text: 'Damage-oriented, willingness-to-pay weighted single-score method, by IVL Swedish Environmental Research Institute.',
    facts: ['Endpoint / single score (ELU)', 'Monetary (WTP) weighting']
  },
  {
    pattern: /\bcrustal scarcity\b/i,
    name: 'Crustal Scarcity Indicator',
    url: 'https://doi.org/10.1007/s11367-020-01781-1',
    text: 'Abiotic resource scarcity based on average crustal concentration of elements (kg silicon-equivalents).',
    facts: ['Mineral resource scarcity', 'Crustal-content basis (Chalmers)']
  },
  {
    pattern: /\b(LCI|inventory)\b/i,
    name: 'Inventory results & indicators',
    text: 'Selected life-cycle inventory flows reported directly (not characterised impacts) — e.g. specific resource or emission totals.',
    facts: ['Raw inventory flows', 'Not an impact-assessment method']
  }
]

/**
 * Where a background database is published.
 *
 * The most-cited source in any LCA report, and the one the bibliography left blank: the method families
 * had references while the database they all draw on did not. Matched by name because that is all the
 * report knows about it — the name comes from the user's own import.
 */
export function databaseReference(name: string): MethodInfo | null {
  const n = (name || '').toLowerCase()
  if (n.includes('ecoinvent')) {
    return {
      name,
      url: 'https://ecoinvent.org/',
      text: 'Background life cycle inventory database maintained by the ecoinvent Association.',
      facts: []
    }
  }
  if (n.includes('bafu')) {
    // The citation BAFU's terms of use ask for, word for word (the year comes from the name).
    const year = name.match(/(\d{4})/)?.[1] ?? '20XY'
    return {
      name,
      url: 'https://www.bafu.admin.ch/bafu/en/home/topics/economy-consumption/state/life-cycle-assessment.html',
      text: `Life Cycle Inventory database of the Swiss Federal Administration, BAFU:${year}.`,
      facts: []
    }
  }
  return null
}

/** One reference per background database — a provenance string may name two ("a, b") when a
 *  model draws on both ecoinvent and BAFU. */
export function databaseReferences(names: string): MethodInfo[] {
  return (names || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => databaseReference(n))
    .filter((r): r is MethodInfo => r !== null)
}

export function methodFamilyInfo(family: string): MethodInfo | null {
  for (const e of ENTRIES) {
    if (e.pattern.test(family)) {
      const { pattern: _pattern, ...info } = e
      return info
    }
  }
  return null
}
