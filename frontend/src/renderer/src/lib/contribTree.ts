/**
 * The contribution tree, as an imperative D3 controller — no React in here.
 *
 * This is the drawing half of the Detailed-results view: PrismLCA-styled process cards on a white
 * canvas, collapsible, pan/zoom, hover card, ISIC-coloured. It lived as a 400-line `useEffect`
 * inside the view, where nothing of it could be typed or tested and every render concern leaked
 * into component state. The controller owns the D3 scene; the component owns the DOM refs, the
 * resize observation and the toolbar, and re-creates the controller exactly when the old effect
 * re-ran (data, digits, host size).
 *
 * Selection lives here too, per instance: node ids are minted fresh with each build, so a new
 * controller starting unselected is the same rule the old effect enforced by resetting its refs.
 * The click handlers reach the view through a `{ current }` box rather than captured props — the
 * old code kept them in refs so a re-bound callback never forced the (expensive) rebuild, and that
 * behaviour is kept: the box is read at click time.
 */
import * as d3 from 'd3'
import { fmtSig } from './settings'
import {
  CARD,
  colourBarPath,
  contentW,
  ellipsise,
  fitLines,
  metaText,
  shareWidths,
  trackW,
  zonePath
} from './treeCard'

/** One node of the meta+lookups+tree envelope (POST /calc/contribution), short fields as shipped. */
export interface TreeNode {
  db: string
  c: string
  n: string
  g: string
  a: number
  u: string
  imp: number
  dir: number
  shr: number
  isic?: string
  cpc?: string
  ch?: TreeNode[]
}

export interface ContribResponse {
  meta: {
    database: string
    method: string[]
    total: number
    unit: string
    direct: number
    upstream: number
    n_nodes: number
    cutoff: number
    max_depth: number
  }
  lookups: { isic?: Record<string, string>; cpc?: Record<string, string> }
  tree: TreeNode
  aggregation?: { dimension: string; groups: { key: string; impact: number; share: number }[] }
}

// ISIC Rev.4 section colours — matches the MCP contribution-tree skill. Categorical DATA colours,
// not theme tokens: a sector keeps its colour in both themes, like the report palettes do.
export const ISIC_COLOR: Record<string, string> = {
  A: '#639922',
  B: '#5F5E5A',
  C: '#534AB7',
  D: '#BA7517',
  E: '#A32D2D',
  F: '#888780',
  G: '#7A8A99',
  H: '#378ADD'
}
export const isicColor = (code?: string): string => (code && ISIC_COLOR[code]) || '#8a94a0'
// Muted companion of a card colour — used for the expand zone and the sharebar, mirroring
// how the navy root card pairs with its lighter #3d5f7a zone.
/** A wash of the card colour: the pale half of the share bar, and the expand zone.
 *
 *  Both used to take a *muted* version of the colour (same hue, a little lighter), which was right
 *  when the whole card was that colour. On a white card it was not: the first render had the zone
 *  reading as a coloured tab stuck to the card's edge, with the chevron and its count lost inside it. */
export const tint = (hex: string, towardsWhite: number): string =>
  d3.interpolateRgb(hex, '#ffffff')(towardsWhite)

// Card geometry — every node is the same fixed size for a tidy, uniform tree; the numbers and the
// text fitting live in `lib/treeCard.ts`, where they can be tested without a DOM.
const NODE_W = CARD.W
const NODE_H = CARD.H
const COL_GAP = 320 // horizontal distance between tiers (card width + link gap)
const ZONE_W = CARD.ZONE_W
const ZONE_PATH = zonePath()

/** Text width in the card's own font — SVG has no box model, so every line is measured. */
const measurer = (font: string): ((text: string) => number) => {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return (t: string) => t.length * 6 // no canvas (a headless export): a decent guess
  ctx.font = font
  return (t: string) => ctx.measureText(t).width
}
const FONT_STACK = '"Noto Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const measureTitle = measurer(`600 12px ${FONT_STACK}`)
const measureMeta = measurer(`10px ${FONT_STACK}`)

/** A laid-out node: d3's hierarchy node plus the mutable fields the collapsible-tree pattern pins on
 *  it (previous position for the enter/exit animations, the folded-away children, a stable id). */
interface TreeH
  extends Omit<
    d3.HierarchyNode<TreeNode>,
    'id' | 'children' | 'parent' | 'descendants' | 'links' | 'eachBefore'
  > {
  id: number
  x: number
  y: number
  x0: number
  y0: number
  children?: TreeH[] | null
  _children?: TreeH[] | null
  parent: TreeH | null
  descendants: () => TreeH[]
  links: () => Array<{ source: TreeH; target: TreeH }>
  eachBefore: (fn: (node: TreeH) => void) => TreeH
}

export interface ContribTreeControls {
  expandAll: () => void
  collapseAll: () => void
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
}

export interface ContribTreeHandlers {
  onSelect?: (node: TreeNode | null) => void
  /** Opens the process-details window (same one the model search uses). */
  onShowDetails?: (target: { database: string; code: string }) => void
}

export interface ContribTreeInstance {
  controls: ContribTreeControls
  destroy: () => void
}

export function renderContribTree(opts: {
  host: HTMLElement
  svg: SVGSVGElement
  /** The hover card the cursor fills — plain DOM, shown/hidden by class. */
  info: HTMLDivElement
  data: ContribResponse
  digits: number
  /** Read at click time, never captured: rebinding a callback must not rebuild the scene. */
  handlers: { current: ContribTreeHandlers }
}): ContribTreeInstance {
  const { host, svg: svgEl, info: infoEl, data, digits, handlers } = opts
  const W = host.clientWidth || 900
  const H = host.clientHeight || 600
  const unit = data.meta.unit
  const isicNames = data.lookups?.isic ?? {}
  const cpcNames = data.lookups?.cpc ?? {}

  const svg = d3.select(svgEl).attr('viewBox', `0 0 ${W} ${H}`)
  svg.selectAll('*').remove()
  const g = svg.append('g')
  const gLinks = g.append('g').attr('fill', 'none')
  const gNodes = g.append('g')

  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.08, 4])
    .on('zoom', (e) => g.attr('transform', e.transform.toString()))
  svg.call(zoom)
  const initialT = d3.zoomIdentity.translate(40, H / 2).scale(0.85)
  svg.call(zoom.transform, initialT)

  const root = d3.hierarchy(data.tree, (d: TreeNode) => d.ch) as unknown as TreeH
  let uid = 0
  root.x0 = H / 2
  root.y0 = 0
  root.descendants().forEach((d) => {
    d.id = ++uid
    d._children = d.children
    if (d.depth >= 2 && d.children) d.children = null // initially expand only to depth 2
  })

  const layout = d3.tree().nodeSize([NODE_H + 16, COL_GAP])
  const clampShr = (shr: number): number => Math.min(1, Math.max(0, Math.abs(shr)))
  const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  const cardW = (_d?: TreeH): number => NODE_W
  // Curved connector from a parent card's right edge to a child card's left edge.
  const linkPath = (s: { x: number; y: number }, t: { x: number; y: number }): string => {
    const sx = s.y + NODE_W
    const mx = (sx + t.y) / 2
    return `M${sx},${s.x} C${mx},${s.x} ${mx},${t.x} ${t.y},${t.x}`
  }

  // Names, geographies and units are model data and go into innerHTML: a dataset named
  // "<style>#root{display:none}</style>" would have taken the app with it on hover.
  const esc = (s: unknown): string =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const showInfo = (d: TreeH): void => {
    const n: TreeNode = d.data
    const parent = d.parent
    const shareParent = parent && parent.data.imp ? (n.imp / parent.data.imp) * 100 : 100
    const isicName = (n.isic && isicNames[n.isic]) || '—'
    const cpcName = (n.cpc && cpcNames[n.cpc]) || '—'
    infoEl.innerHTML =
      `<div class="name">${esc(n.n)}</div>` +
      `<div class="row"><span>Geography</span><span>${esc(n.g || '–')}</span></div>` +
      (n.isic
        ? `<div class="row"><span>ISIC ${esc(n.isic)}</span><span>${esc(trunc(isicName, 34))}</span></div>`
        : '') +
      (n.cpc
        ? `<div class="row"><span>CPC ${esc(n.cpc)}</span><span>${esc(trunc(cpcName, 34))}</span></div>`
        : '') +
      `<div class="row"><span>Amount</span><span>${fmtSig(n.a, digits)} ${esc(n.u)}</span></div>` +
      `<div class="row"><span>Share of total</span><span><b>${(n.shr * 100).toFixed(2)}%</b></span></div>` +
      `<div class="row"><span>Share of parent</span><span>${shareParent.toFixed(1)}%</span></div>` +
      `<div class="row"><span>Cumulative</span><span>${fmtSig(n.imp, digits)} ${esc(unit)}</span></div>` +
      `<div class="row"><span>Direct</span><span>${fmtSig(n.dir, digits)} ${esc(unit)}</span></div>`
    infoEl.classList.add('show')
  }
  const hideInfo = (): void => infoEl.classList.remove('show')

  // The clicked node AND its whole subtree (its flows include all descendants) — per instance:
  // node ids are minted with the build, so any earlier selection is void by construction.
  let selIds = new Set<number>()
  let selAnchor: number | null = null
  const cls = (d: TreeH): string =>
    'cnode' +
    (d.depth === 0 ? ' root' : '') +
    (d._children && !d.children ? ' collapsed' : '') +
    (selIds.has(d.id) ? ' sel' : '')
  // Collapsed points right (▸ = click to fan the subtree out to the right); expanded points
  // back left (◂ = click to fold it away).
  const chevron = (d: TreeH): string => (d._children || d.children ? (d.children ? '◂' : '▸') : '')
  // Everything under a folded card, not just its children: the number answers "how much is hidden
  // here", and that is the whole subtree the click would bring on screen.
  const countHidden = (kids: TreeH[]): number =>
    kids.reduce((n: number, k: TreeH) => n + 1 + countHidden((k.children ?? k._children ?? []) as TreeH[]), 0)

  // Click on the empty canvas = back to the whole system. Card/zone clicks never reach here
  // (their targets are shapes inside <g>), and d3-zoom suppresses the click after a pan.
  svg.on('click', (e: MouseEvent) => {
    if (e.target !== svgEl) return
    selAnchor = null
    selIds = new Set()
    handlers.current.onSelect?.(null)
    gNodes.selectAll<SVGGElement, TreeH>('g.cnode').attr('class', cls)
  })

  function update(source: TreeH): void {
    layout(root as unknown as d3.HierarchyNode<unknown>)
    const nodes = root.descendants()
    const links = root.links()

    // LINKS
    const link = gLinks
      .selectAll<SVGPathElement, { source: TreeH; target: TreeH }>('path.link')
      .data(links, (d) => d.target.id)
    link
      .enter()
      .append('path')
      .attr('class', 'link')
      .attr('stroke-width', (d) => 1 + clampShr(d.target.data.shr) * 6)
      .attr('d', () => {
        const o = { x: source.x0, y: source.y0 }
        return linkPath(o, o)
      })
      .merge(link)
      .transition()
      .duration(280)
      .attr('stroke-width', (d) => 1 + clampShr(d.target.data.shr) * 6)
      .attr('d', (d) => linkPath(d.source, d.target))
    link
      .exit()
      .transition()
      .duration(280)
      .attr('d', () => {
        const o = { x: source.x, y: source.y }
        return linkPath(o, o)
      })
      .remove()

    // NODES (process cards)
    const node = gNodes.selectAll<SVGGElement, TreeH>('g.cnode').data(nodes, (d) => d.id)
    const enter = node
      .enter()
      .append('g')
      .attr('class', cls)
      .attr('transform', () => `translate(${source.y0},${source.x0})`)
      .attr('opacity', 0)
      .on('click', (_e: unknown, d: TreeH) => {
        // Card body = scope the elementary-flows panel (root or re-click = whole system).
        // The highlight covers the node plus every descendant — collapsed ones included —
        // since their flows are consolidated into it. Expand/collapse lives in the zone.
        if (d.depth === 0 || selAnchor === d.id) {
          selAnchor = null
          selIds = new Set()
          handlers.current.onSelect?.(null)
        } else {
          const ids = new Set<number>()
          const collect = (n: TreeH): void => {
            ids.add(n.id)
            ;((n.children ?? n._children ?? []) as TreeH[]).forEach(collect)
          }
          collect(d)
          selAnchor = d.id
          selIds = ids
          handlers.current.onSelect?.(d.data)
        }
        gNodes.selectAll<SVGGElement, TreeH>('g.cnode').attr('class', cls)
      })
      .on('mouseenter', (_e: unknown, d: TreeH) => showInfo(d))
      .on('mouseleave', hideInfo)
    enter
      .append('rect')
      .attr('class', 'cnode-card') // NOT "card" — the global .card CSS sets width and would win over the attr
      .attr('x', 0)
      .attr('y', -NODE_H / 2)
      .attr('height', NODE_H)
      .attr('rx', CARD.R)
    // The ISIC colour as a bar along the top, the way a coloured process box carries it on the
    // canvas. The card body stays white, which is what buys room for the name and the figures.
    enter
      .append('path')
      .attr('class', 'cnode-topbar')
      .attr('d', colourBarPath())
      // Root leaves the fill to CSS (a live theme switch then recolours the mounted tree);
      // data nodes carry their categorical ISIC colour inline.
      .style('fill', (d) => (d.depth === 0 ? null : isicColor(d.data.isic)))
    // The name over up to two lines — one <text> per line, because SVG does not wrap.
    enter.append('text').attr('class', 'nm nm1').attr('x', CARD.PAD).attr('y', CARD.TITLE1_Y)
    enter.append('text').attr('class', 'nm nm2').attr('x', CARD.PAD).attr('y', CARD.TITLE2_Y)
    // Meta line: a dot in the section colour, then what kind of process this is and where.
    enter
      .append('circle')
      .attr('class', 'meta-dot')
      .attr('cx', CARD.PAD + 3.5)
      .attr('cy', CARD.META_Y - 3.5)
      .attr('r', 3.5)
      .style('fill', (d) => (d.depth === 0 ? null : isicColor(d.data.isic)))
    enter
      .append('text')
      .attr('class', 'meta')
      .attr('x', CARD.PAD + 13)
      .attr('y', CARD.META_Y)
    // The figure and the share, one line: value left, percentage right — the reading order the
    // compact card keeps from the full one.
    enter.append('text').attr('class', 'val').attr('x', CARD.PAD).attr('y', CARD.SHARE_Y)
    enter
      .append('text')
      .attr('class', 'pct')
      .attr('x', NODE_W - CARD.RIGHT)
      .attr('y', CARD.SHARE_Y)
      .attr('text-anchor', 'end')
    // The share bar: pale for what the branch carries, solid for what this process emits itself.
    enter
      .append('rect')
      .attr('class', 'bar-track')
      .attr('x', CARD.PAD)
      .attr('y', CARD.BAR_Y)
      .attr('width', trackW())
      .attr('height', CARD.BAR_TH)
      .attr('rx', CARD.BAR_TH / 2)
    enter
      .append('rect')
      .attr('class', 'bar-fill')
      .attr('x', CARD.PAD)
      .attr('y', CARD.BAR_Y)
      .attr('height', CARD.BAR_TH)
      .attr('rx', CARD.BAR_TH / 2)
      .attr('width', 0)
      .style('fill', (d) => (d.depth === 0 ? null : tint(isicColor(d.data.isic), 0.55)))
    enter
      .append('rect')
      .attr('class', 'bar-direct')
      .attr('x', CARD.PAD)
      .attr('y', CARD.BAR_Y)
      .attr('height', CARD.BAR_TH)
      .attr('rx', CARD.BAR_TH / 2)
      .attr('width', 0)
      .style('fill', (d) => (d.depth === 0 ? null : isicColor(d.data.isic)))
    // Expand/collapse zone on the right — only cards that actually have a subtree get one.
    // Drawn late so it sits above the sharebar; the big chevron text goes on top of it.
    enter
      .filter((d) => !!(d._children || d.children))
      .append('path')
      .attr('class', 'chev-zone')
      .attr('d', ZONE_PATH)
      // Inline style so it wins over the stylesheet; the navy root keeps its CSS colour.
      .style('fill', (d) => (d.depth === 0 ? null : tint(isicColor(d.data.isic), 0.86)))
      .on('click', (e: MouseEvent, d: TreeH) => {
        e.stopPropagation() // don't let the toggle click reach the card body (= breakdown scope)
        d.children = d.children ? null : d._children
        update(d)
        gNodes.selectAll<SVGGElement, TreeH>('g.cnode').attr('class', cls)
        fit() // re-fit the view after every expand/collapse the user does
      })
    enter.append('text').attr('class', 'chev').attr('y', -1).attr('text-anchor', 'middle')
    // How many children are folded away — the chevron alone never said, and "is there more under
    // this?" is the question the tree exists to answer.
    enter.append('text').attr('class', 'chev-n').attr('y', 13).attr('text-anchor', 'middle')

    // Info button — same window as the ⓘ in the model search's result list. Only on background
    // (ecoinvent) processes: a foreground process is edited on the canvas, a background dataset has
    // no other doorway to its documentation from here.
    const info = enter
      .filter((d) => Boolean(d.data.db) && d.data.db !== root.data.db && Boolean(d.data.c))
      .append('g')
      .attr('class', 'cnode-info')
      .attr('transform', `translate(${CARD.INFO_X},${CARD.INFO_Y})`)
      .on('click', (e: MouseEvent, d: TreeH) => {
        e.stopPropagation() // the card click scopes the flows panel; this one opens the window
        handlers.current.onShowDetails?.({ database: d.data.db, code: d.data.c })
      })
    info.append('title').text('Process details')
    info.append('circle').attr('r', 7)
    info.append('text').attr('text-anchor', 'middle').attr('y', 3.5).text('i')

    const merged = enter.merge(node)
    merged.select('.cnode-card').attr('width', (d) => cardW(d))
    merged
      .select('.chev')
      .attr('x', (d) => cardW(d) - ZONE_W / 2)
      .text(chevron)
    merged
      .select('.chev-n')
      .attr('x', (d) => cardW(d) - ZONE_W / 2)
      // Only while folded: an open branch shows its children, and repeating the count there would
      // be a number the eye has to check against the picture.
      .text((d) => (d._children && !d.children ? countHidden(d._children as TreeH[]) : ''))
    // The name, fitted to the card rather than cut at a character count: "market for transport,
    // freight, lorry 16-32 metric ton" and its three siblings were all "market for transport, f…".
    merged.each(function (d) {
      const hasInfo = Boolean(d.data.db) && d.data.db !== root.data.db && Boolean(d.data.c)
      const lines = fitLines(d.data.n, measureTitle, [contentW(hasInfo), contentW(false)])
      const sel = d3.select(this)
      sel.select('.nm1').text(lines[0] ?? '')
      sel.select('.nm2').text(lines[1] ?? '')
      // With one line only, the name sits where two lines would have ended — the meta line and the
      // figures below keep their place, so cards of both kinds still read as one row.
      sel.select('.nm1').attr('y', lines.length > 1 ? CARD.TITLE1_Y : CARD.TITLE2_Y)
      sel.select('.meta').text(
        metaText(
          {
            isic: d.data.isic,
            isicName: d.data.isic ? isicNames[d.data.isic] : undefined,
            geo: d.data.g,
            own: d.depth > 0 && d.data.db === root.data.db,
            root: d.depth === 0
          },
          measureMeta,
          contentW(false) - 13
        )
      )
      const value = `${fmtSig(d.data.imp, digits)} ${unit}`
      sel.select('.val').text(ellipsise(value, measureMeta, contentW(false) - 52))
    })
    merged.select('.pct').text((d) => `${(d.data.shr * 100).toFixed(1)}%`)
    const widths = (d: TreeH): { fill: number; direct: number } =>
      shareWidths({ impact: d.data.imp, direct: d.data.dir, total: data.meta.total })
    merged
      .select('.bar-fill')
      .transition()
      .duration(280)
      .attr('width', (d) => widths(d as TreeH).fill)
    merged
      .select('.bar-direct')
      .transition()
      .duration(280)
      .attr('width', (d) => widths(d as TreeH).direct)
    merged
      .transition()
      .duration(280)
      .attr('transform', (d) => `translate(${d.y},${d.x})`)
      .attr('opacity', 1)
      .attr('class', cls)
    node
      .exit()
      .transition()
      .duration(280)
      .attr('transform', () => `translate(${source.y},${source.x})`)
      .attr('opacity', 0)
      .remove()

    root.eachBefore((d) => {
      d.x0 = d.x
      d.y0 = d.y
    })
  }

  const expandAll = (d: TreeH): void => {
    if (d._children) {
      d.children = d._children
      d.children.forEach(expandAll)
    }
  }
  const collapseAll = (d: TreeH): void => {
    if (d.children) {
      d.children.forEach(collapseAll)
      d._children = d.children
      d.children = null
    }
  }
  // Fit from the layout coordinates (reliable right after an update, before transitions finish).
  const fit = (): void => {
    const ns = root.descendants()
    if (!ns.length) return
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    ns.forEach((d) => {
      minX = Math.min(minX, d.x - NODE_H / 2)
      maxX = Math.max(maxX, d.x + NODE_H / 2)
      minY = Math.min(minY, d.y)
      maxY = Math.max(maxY, d.y + NODE_W)
    })
    const bw = maxY - minY
    const bh = maxX - minX
    if (bw <= 0 || bh <= 0) return
    const scale = Math.min(1.2, 0.92 * Math.min(W / bw, H / bh))
    const tx = W / 2 - scale * (minY + bw / 2)
    const ty = H / 2 - scale * (minX + bh / 2)
    svg
      .transition()
      .duration(400)
      .call(zoom.transform as never, d3.zoomIdentity.translate(tx, ty).scale(scale))
  }

  update(root)

  return {
    controls: {
      expandAll: () => {
        expandAll(root)
        update(root)
        fit()
      },
      collapseAll: () => {
        if (root.children) root.children.forEach(collapseAll)
        update(root)
        fit()
      },
      zoomIn: () =>
        void svg
          .transition()
          .duration(180)
          .call(zoom.scaleBy as never, 1.3),
      zoomOut: () =>
        void svg
          .transition()
          .duration(180)
          .call(zoom.scaleBy as never, 1 / 1.3),
      fit
    },
    destroy: () => {
      svg.selectAll('*').remove()
    }
  }
}
