/**
 * Three reference products for the research eval, each with what is public about it and what is not.
 *
 * Every target value comes from a public manufacturer or retailer page, retrieved on 15 Nov 2026 and listed under
 * `sources`; docs/DATENHERKUNFT.md records the set. Where nothing public states a figure, the span is a
 * reasoned estimate (`basis: 'estimate'`), wide on purpose: a different estimate with its reasons stays inside
 * and costs nothing, while the gates ask for what IS public — a published weight, the version the user means,
 * the printed ingredient list — and for honesty about the rest.
 *
 * `climateShare` is the share of the product's cradle-to-grave GWP100 the part carries in an overview
 * calculation with public emission factors (steel and board EPDs, surfactant inventories); it weights the
 * accuracy, so a wrong frame costs what it would cost the result and wrong handles almost nothing.
 *
 * The calls are the ones a German-speaking user's chat made for these products, kept word for word so runs stay
 * comparable across models and lookup caps.
 */
import type { RecipeRequest } from '../bomRecipe'
import {
  formulationNotOwn,
  fitsLabel,
  gate,
  labelFound,
  materialOf,
  noMassAbove,
  otherVersionKeptApart,
  partWithin,
  partsSumWithin,
  recipeCloses,
  totalFound,
  totalUsedWithin,
  type ReferenceGate,
  type ReferencePart
} from './score'

export interface ReferenceProduct {
  /** Scenario name; `PRISM_EVAL_ONLY=ref` picks all three. */
  name: string
  title: string
  call: { product: string; context: string; components: string[]; recipe?: RecipeRequest }
  /** In the order entries are assigned: the first part an entry's name matches takes it. */
  parts: ReferencePart[]
  gates: ReferenceGate[]
  sources: string[]
}

const STEEL = /stahl|steel|verzink|galvani[sz]|zink|zinc/i
const PLASTIC = /kunststoff|plastic|polyprop|polyeth|\bpp\b|\bpe\b|hdpe/i

const WHEELBARROW: ReferenceProduct = {
  name: 'ref-wheelbarrow',
  title: 'CAPITO PRAKTICA 150 wheelbarrow (EAN 4027972127043, assembled)',
  call: {
    product:
      'CAPITO Profi Schubkarre PRAKTICA 150 Liter Jumbomulde, Luftrad mit Rillenprofil und Stahlfelge, ergonomische Buchenholzgriffe',
    context:
      'Schubkarre für den deutschen Markt (Baumarkt, z. B. Hornbach, Bauhaus, OBI). Marke CAPITO (Carl Capito GmbH), ' +
      'Modell PRAKTICA, 150-l-Jumbomulde aus Stahlblech, Luftrad mit Rillenprofil auf Stahlfelge, zwei Griffe aus ' +
      'Buchenholz, Rahmen aus Stahlrohr. Für eine Screening-LCA, Referenzjahr 2026.',
    components: [
      'Mulde (150 l, Stahlblech)',
      'Rahmen/Holme (Stahlrohr)',
      'Luftreifen mit Schlauch',
      'Stahlfelge',
      'Buchenholzgriffe (2 Stück)',
      'Achse, Lager, Schrauben, Standfüße'
    ]
  },
  parts: [
    {
      id: 'tub',
      label: 'tub, 1.25-mm galvanised sheet',
      match: /mulde|\btub\b|tray|bowl/i,
      where: 'items',
      accept: [[10.5, 12.0]],
      basis: 'sourced',
      climateShare: 48,
      note: '11.0 kg, the article weight of the spare tub 10121; its sheet area gives 11.7 kg'
    },
    {
      id: 'frame',
      label: 'frame and legs, painted steel tube',
      match: /rahmen|holm|frame|chassis/i,
      where: 'items',
      accept: [[5.1, 8.3]],
      basis: 'estimate',
      climateShare: 26,
      note: 'not published; ≈ 6.8 kg from the tube sizes (Ø 34 × 1.5, Ø 26 × 1.5 mm) or as 20.7 kg less the other parts, 8.3 kg against the 22.2-kg total'
    },
    {
      id: 'wheel',
      label: 'tyre, tube and steel rim',
      match: /reifen|schlauch|felge|tyre|tire|\brim\b|wheel|\brad\b|luftrad/i,
      where: 'items',
      accept: [[1.9, 3.2]],
      basis: 'sourced',
      climateShare: 14,
      note: 'the complete wheel with its axle weighs 2.50 kg (catalogue, one retailer) or 3.23 kg (another), less the 0.18-kg axle'
    },
    {
      id: 'handles',
      label: 'two beech handles',
      match: /griff|grip/i,
      where: 'items',
      accept: [[0.18, 0.3]],
      basis: 'sourced',
      climateShare: 0.1,
      note: '0.11 kg each, the spare handle 41080'
    },
    {
      id: 'small',
      label: 'axle, bearings, bolts, feet',
      match: /achse|lager|schraub|standf|axle|bearing|screw|bolt|feet|foot/i,
      where: 'items',
      accept: [[0.2, 2.2]],
      basis: 'estimate',
      climateShare: 1,
      note: 'axle 0.18 kg (17 × 101 mm solid steel), bearings ≈ 0.13 kg, tub bolts 0.08 kg; up to 1.6 kg more where the feet are booked here'
    }
  ],
  gates: [
    gate('fact', 'tub-weight', 'the tub at its published 11.0 kg (10.5–12.0)', partWithin('tub', 10.5, 12.0)),
    gate(
      'fact',
      'wheel-weight',
      'tyre, tube and rim at the published wheel weight (1.9–3.2 kg)',
      partWithin('wheel', 1.9, 3.2)
    ),
    gate(
      'fact',
      'handles-weight',
      'the handles at their published 0.22 kg (0.18–0.30)',
      partWithin('handles', 0.18, 0.3)
    ),
    gate(
      'fact',
      'total-found',
      'a published whole-product mass found (19.0–22.5 kg)',
      totalFound(19.0, 22.5)
    ),
    gate('fact', 'tub-steel', 'the tub is galvanised steel, not plastic', materialOf('tub', STEEL, PLASTIC)),
    gate(
      'fact',
      'frame-painted',
      'the frame is painted steel, not galvanised',
      materialOf('frame', /stahl|steel/i, /verzink|galvani[sz]|zink|zinc/i)
    ),
    gate(
      'consistency',
      'total-used',
      'a total the balance used is this model’s (19.0–22.5 kg)',
      totalUsedWithin(19.0, 22.5)
    ),
    gate(
      'consistency',
      'parts-sum',
      'the parts add up to a wheelbarrow (17.0–24.5 kg)',
      partsSumWithin(17.0, 24.5)
    )
  ],
  sources: [
    'https://www.capito-gmbh.com/files/motivation_car_service/images/Capito/Downloads/Praktica_Artikeldatenblatt%202025.pdf',
    'https://media.hornbach.de/hb/document/as.75853035.pdf',
    'https://www.hornbach.de/p/capito-profi-schubkarre-praktica-150-liter-jumbomulde-luftrad-mit-rillenprofil-und-stahlfelge-inkl-ergonomische-buchenholzgriffe/5691696/',
    'https://www.siepmann.net/Capito-Schubkarre-Praktica.html',
    'https://www.meinhausshop.de/Schubkarren-Mulde-Capito-fuer-Practica-150L-verzinkt-und-gelocht',
    'https://www.tandmore.de/Haus-Garten/Werkstatt-und-Baustellenbedarf/Transportgeraete/Schubkarren/CAPITO-10509-Luftrad-400-100-Kugell-17mm-O-mit-Schraubachse::921774.html',
    'https://www.meinhausshop.de/Schubkarrenrad-400-x-100-Capito-Luftgefuellt-mit-Schlauch-Inkl.-Achse',
    'https://www.meinhausshop.de/Schubkarren-Holzgriff-1-Capito-fuer-Practica/Eurocar/Export-1-Stueck'
  ]
}

const SHELF: ReferenceProduct = {
  name: 'ref-shelf',
  title: 'avasco Atlas 175 boltless shelf, galvanised, five 5-mm HDF boards (EAN 5400431601459)',
  call: {
    product: 'Schwerlastregal Atlas verzinkt 176x90x40 cm Stecksystem 5 Holzböden Tragkraft 875 kg',
    context:
      'Steckregal für Keller und Garage, verkauft in Deutschland (Baumarkt und Online-Handel). Verzinkter Stahl, 5 ' +
      'Fachböden aus Holzwerkstoff, werkzeuglos steckbar. Für eine Screening-LCA, Referenzjahr 2026.',
    components: [
      'Stahlrahmen (Pfosten und Traversen, verzinkt)',
      '5 Fachböden aus Holzwerkstoff',
      'Kunststofffüße und Kleinteile',
      'Verkaufsverpackung (Karton)'
    ]
  },
  parts: [
    {
      id: 'steel',
      label: 'uprights and beams, strip-galvanised steel',
      match: /stahl|steel|pfost|travers|upright|beam|rahmen|frame/i,
      where: 'items',
      accept: [[5.5, 8.0]],
      basis: 'estimate',
      climateShare: 68,
      note: 'not published; ≈ 6.4 kg for 21.9 m of 0.6-mm profile, 5.5–8.0 kg is what fits the 14.1-kg carton weight beside the boards'
    },
    {
      id: 'shelves',
      label: 'five HDF boards, 5 mm',
      match: /b[öo]den|shel(?:f|ves)|board|platte/i,
      where: 'items',
      accept: [[5.5, 8.4]],
      basis: 'estimate',
      climateShare: 16,
      note: 'not published; ≈ 7.1 kg for five 0.88 × 0.38 m boards at 800–950 kg/m³, the 13-kg 4-mm version points to ≈ 5.5 kg'
    },
    {
      id: 'small',
      label: 'connectors and foot caps',
      match: /kunststoff|plastic|f[üu](?:ß|ss)e|feet|kappe|\bcaps?\b|kleinteil|verbinder|connector/i,
      where: 'items',
      accept: [[0.03, 0.4]],
      basis: 'estimate',
      climateShare: 3,
      note: '≈ 0.1 kg'
    },
    {
      id: 'packaging',
      label: 'carton and film',
      match: /verpack|karton|carton|\bbox\b|folie|film|packag/i,
      where: 'items',
      packaging: true,
      accept: [[0.2, 0.9]],
      basis: 'estimate',
      climateShare: 1.5,
      note: 'carton ≈ 0.45 kg and film ≈ 0.05 kg; the instructions mark corrugated board and LDPE'
    }
  ],
  gates: [
    gate('fact', 'total-found', 'the 14.1 kg printed on the carton found', totalFound(13.9, 14.3)),
    gate(
      'fact',
      'boards-fibreboard',
      'the boards are fibreboard (HDF), not solid wood or chipboard',
      materialOf(
        'shelves',
        /hdf|mdf|faserplatte|fib(?:re|er) ?board|holzfaser|hartfaser/i,
        /massiv|solid|vollholz|fichte|kiefer|spruce|pine|spanplatte|chipboard|particle/i
      )
    ),
    gate(
      'consistency',
      'no-load-as-mass',
      'no load rating read as a mass (nothing ≥ 50 kg)',
      noMassAbove(50)
    ),
    gate(
      'consistency',
      'other-version-apart',
      'the 13-kg 4-mm version (EAN …480) is named as such, not taken for this one',
      otherVersionKeptApart(12.8, 13.2, /4\s*mm|hdf\s*-?\s*4\b|601480|schwarz|black|pulver|powder/i)
    ),
    gate(
      'consistency',
      'total-used',
      'a total the balance used is this version’s (13.4–14.3 kg)',
      totalUsedWithin(13.4, 14.3)
    ),
    gate('consistency', 'parts-sum', 'the parts fit the product (10.4–16.2 kg)', partsSumWithin(10.4, 16.2))
  ],
  sources: [
    'https://www.hornbach.de/p/schwerlastregal-atlas-verzinkt-176x90x40-cm-stecksystem-5-holzboeden-tragkraft-875-kg/12008577/',
    'https://media.hornbach.de/hb/brochure/as.78823893.pdf',
    'https://media.adeo.com/media/5520780/media.pdf',
    'https://www.brico.be/nl/meubels-opbergen/wasruimte-garage-keldermeubels/stellingkasten-palletstellingen/stellingkasten/avasco-stellingkast-atlas-176x90x40cm-draagkracht-175kg-verzinkt/10119671',
    'https://www.brico.be/fr/meubles-rangements/meubles-buanderie-garage-cave/etageres-rangement-etageres-rayonnage/etageres-rangement/etagere-avasco-atlas-176x90x40cm-charge-max-175kg-galvanise/10322182'
  ]
}

/** As printed on the pack and the retailer's product page. */
export const SOAP_INCI = [
  'AQUA',
  'SODIUM LAURETH SULFATE',
  'SODIUM CHLORIDE',
  'COCAMIDOPROPYL BETAINE',
  'GLYCERIN',
  'PARFUM',
  'SODIUM BENZOATE',
  'GLYCERYL OLEATE',
  'COCO GLUCOSIDE',
  'CITRIC ACID',
  'POTASSIUM SORBATE',
  'GLYCOL DISTEARATE',
  'SODIUM LACTATE',
  'BETAINE',
  'TOCOPHEROL',
  'HYDROGENATED PALM GLYCERIDES CITRATE',
  'SODIUM HYDROXIDE'
]

const SOAP: ReferenceProduct = {
  name: 'ref-soap',
  title: 'Balea liquid soap Eucalyptus & Lotus, 500-ml refill pouch (GTIN 4070765029765)',
  call: {
    product: 'Balea Flüssigseife Eukalyptus & Lotus, Nachfüllpack 500 ml',
    context:
      'dm-Eigenmarke Balea, verkauft in Deutschland (dm-drogerie markt), Nachfüllbeutel (Standbodenbeutel) mit ' +
      '500 ml Flüssigseife. Screening-LCA, Referenzjahr 2025.',
    components: ['Nachfüllbeutel (Standbodenbeutel, Verbundfolie)', 'Ausgießer mit Schraubverschluss'],
    recipe: { of: 'Flüssigseife (Inhalt des Beutels, 500 ml)' }
  },
  parts: [
    {
      id: 'packaging',
      label: 'stand-up pouch with spout and cap',
      match: /beutel|pouch|folie|film|\bbag\b|ausgie|spout|verschluss|kappe|\bcap\b|closure|fitment/i,
      where: 'items',
      packaging: true,
      accept: [[0.01, 0.017]],
      basis: 'estimate',
      climateShare: 18,
      note: 'not published; pouch ≈ 9.5 g (PET/PE laminate, coded C/PE/PET on the pack), spout ≈ 2.5 g, cap ≈ 1.5 g; a pouch maker states 11–14 g for a 500-ml pouch with cap'
    },
    {
      id: 'sles',
      label: 'sodium laureth sulfate',
      match: /laureth|\bsles\b/i,
      where: 'recipe',
      accept: [[6, 12]],
      // As dosed: a 70-% paste at ≈ 12 %, a 27-% solution at ≈ 31 %.
      acceptAsDosed: [
        [10, 14],
        [24, 36]
      ],
      basis: 'estimate',
      climateShare: 27,
      note: 'shares not published; ≈ 8.5 % active from the printed order and a supplier’s frame recipe (7–11 %), ≈ 31 % when dosed as its 27-% solution'
    },
    {
      id: 'capb',
      label: 'cocamidopropyl betaine',
      match: /cocamidopropyl|\bcapb\b/i,
      where: 'recipe',
      accept: [[1.0, 3.0]],
      acceptAsDosed: [[4, 10]],
      basis: 'estimate',
      climateShare: 9,
      note: '≈ 2 % active, ≈ 7 % when dosed as a 30-% solution'
    },
    {
      id: 'parfum',
      label: 'fragrance',
      match: /parfum|fragrance|perfume|duft/i,
      where: 'recipe',
      accept: [[0.2, 1.2]],
      basis: 'estimate',
      climateShare: 6,
      note: '≈ 0.5 %'
    },
    {
      id: 'salt',
      label: 'sodium chloride',
      match: /sodium chloride|natriumchlorid|kochsalz|\bnacl\b/i,
      where: 'recipe',
      accept: [[1.0, 3.5]],
      basis: 'estimate',
      climateShare: 1,
      note: '≈ 2.5 %; printed before the betaine'
    }
  ],
  gates: [
    gate(
      'fact',
      'label-found',
      'the printed ingredient list found (≥ 80 % of its 17 names)',
      labelFound(SOAP_INCI, 0.8)
    ),
    gate('consistency', 'recipe-closes', 'the recipe closes on its total', recipeCloses()),
    gate(
      'consistency',
      'fits-label',
      'main ingredients present; ingredients the label lacks ≤ 2 % of the mixture',
      fitsLabel(SOAP_INCI, ['AQUA', 'SODIUM LAURETH SULFATE', 'SODIUM CHLORIDE', 'COCAMIDOPROPYL BETAINE'], 2)
    ),
    gate(
      'consistency',
      'pouch-not-bottle',
      'a pouch, not a bottle (5–25 g; a 500-ml bottle with pump weighs 40–55 g)',
      partWithin('packaging', 0.005, 0.025)
    ),
    gate(
      'uncertainty',
      'frame-not-own',
      'the recipe is not passed off as this product’s own (its shares are not public)',
      formulationNotOwn()
    )
  ],
  sources: [
    'https://www.dm.de/p/d/3038087/',
    'https://www.products.pcc.eu/wp-content/uploads/2020/04/Formulation-Guide-Personal-care-and-Cosmetics-EN.pdf',
    'https://yltpacking.com/refill-pouches-better-environment/'
  ]
}

export const REFERENCE_PRODUCTS: ReferenceProduct[] = [WHEELBARROW, SHELF, SOAP]
