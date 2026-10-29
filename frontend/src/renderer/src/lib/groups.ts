/**
 * Node groups on the canvas: a named, coloured box drawn around a set of processes.
 *
 * A group is **view state**, not model data — it says nothing about the LCA, exactly like a node
 * position or a node colour, so it lives in `prism_meta/views.json` under its own `groups` section
 * (see `lib/modelView.ts`) and never on the command bus.
 *
 * Four decisions are encoded here rather than in the component, because all four are the kind of
 * thing that silently rots if it lives in JSX:
 *
 * 1. **Membership is an explicit list of node ids, never geometry.** A process may sit inside the
 *    rectangle of a group it does not belong to. Deriving membership from the box would make that
 *    process a member the moment somebody dragged it there, and would make a group's meaning depend
 *    on the arrangement instead of the other way round.
 * 2. **The rectangle is derived from the members, every render.** Nothing stores it. Move a member
 *    and the box follows because there is no second copy of the truth to keep in step.
 * 3. **A process belongs to at most one group.** Grouping a process that is already boxed *moves* it
 *    (see `addGroup`), and a stored list that says otherwise is repaired on read (see `readGroups`).
 * 4. **The stack is explicit and always below the nodes.** A box carries a `depth`; the order is that
 *    number, and the whole band lives at negative z so no box can ever cover a process or an arrow.
 */
import { NODE_COLORS } from './palette'

/** One group. `members` keeps the order the user selected in; ids are `"<database>/<code>"`. */
export interface NodeGroup {
  id: string
  /** The full-strength palette colour. The box paints it translucently (see `softTint`) so the stored
   *  value stays theme-independent — the same group is a hint on white and on the dark canvas. */
  color: string
  members: string[]
  label?: string
  /** Where the box sits in the stack; higher is nearer the front. Absent means "never restacked" and
   *  reads as 0, so a view written before depth existed keeps the order it had (see `paintOrder`). */
  depth?: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A node as the box needs to see it: where it is and how big it turned out. */
export interface NodeBox {
  x: number
  y: number
  width: number
  height: number
}

/** Air between the outermost member and the box edge. */
export const GROUP_PAD = 22
/** The strip along the top: the drag handle, the name, and the colour dot (see `CanvasGroups`). */
export const GROUP_HEADER = 22

/**
 * The box around `members`, or `null` when none of them is currently on the canvas.
 *
 * Absent members are skipped rather than treated as an error: collapsing a node's upstream takes it
 * off the canvas without deleting anything, and it comes back on the next expand. Membership must
 * survive that, so "not drawn" and "not a member" are different states.
 */
export function groupRect(members: string[], boxes: Map<string, NodeBox>): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of members) {
    const b = boxes.get(id)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  if (minX === Infinity) return null
  return {
    x: minX - GROUP_PAD,
    // The header strip lives inside the box, so the top needs room for it on top of the padding —
    // otherwise it would sit over the topmost process card.
    y: minY - GROUP_PAD - GROUP_HEADER,
    width: maxX - minX + 2 * GROUP_PAD,
    height: maxY - minY + 2 * GROUP_PAD + GROUP_HEADER
  }
}

/* --------------------------------------------------------------------------------------------- */
/* The tint rule                                                                                  */
/* --------------------------------------------------------------------------------------------- */

/**
 * **The palette colour itself, at low opacity.** Not a lightness/saturation-shifted variant of it.
 *
 * The rule this replaces kept the hue but capped saturation at 30 % and pushed lightness to the paper
 * end of the theme — correct arithmetic, and the boxes came out muddy: `#93c120` is a lime, its
 * damped form a grey-green nobody would name, so the box no longer said which colour it was wearing.
 * Alpha keeps the colour intact and lets the canvas do the softening.
 *
 * **Why the alpha differs per theme.** Alpha is measured against what is behind it, and the two
 * canvases are not mirror images: `--bg` is #f3f5f2 (relative luminance 0.887) light and #131c24
 * (0.011) dark. On white the palette's *lightest* colour is the one that nearly disappears (the lime
 * again); on the dark canvas it is the *darkest* — the navy #2f4e66, which at the light canvas's alpha
 * lands at 1.09 contrast against its own background, i.e. invisible. So the two numbers are picked so
 * that **the weakest colour of the palette reaches the same contrast against its own canvas**: 0.16
 * light and 0.20 dark both put it at ~1.11, and the strongest at 1.29 (light) / 1.48 (dark). That band
 * is the one the previous rule produced, so this is a change of *what* the colour is, not of how loud.
 *
 * The border and the strip are the same colour at **three times** that alpha — one number to remember
 * instead of a second table, and it reproduces the old border's presence in both themes (1.37…2.32
 * light, 1.46…2.99 dark).
 *
 * **Why the strip is flattened and the fill is not.** Both are the same colour at the same two alphas;
 * the strip is then composited onto the canvas *by us* and handed over as an opaque colour. It has to
 * be, or depth would be invisible: two translucent layers look almost the same in either order, so
 * with a translucent strip a box brought forward changed its z-index and nothing else — the raise was
 * real and unwatchable. Flattened, the strip of the box in front covers the box behind it, which is
 * the whole point of the control. The fill stays translucent on purpose: seeing *both* tints where two
 * groups overlap is information, and the flattened strip does not take that away.
 */
const FILL_ALPHA = { light: 0.16, dark: 0.2 }
/** The strip and border, as a multiple of the fill — an edge you can see, still not a slab. */
const EDGE_FACTOR = 3
/** `--bg` from index.css, the only thing a group box is ever painted on. Duplicated here because the
 *  flattening above is arithmetic and CSS has no `color-mix` result to read back; the numbers are
 *  asserted against the stylesheet's in groups.test.ts so a theme change cannot pass unnoticed. */
const CANVAS = { light: '#f3f5f2', dark: '#131c24' }

/** `#rrggbb` → `r, g, b`. Unparseable input comes back as a neutral grey rather than as `NaN`s: the
 *  colour is user data on disk, and a group is still worth drawing in grey. */
function channels(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [154, 162, 168] // NEUTRAL_GREY
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const clamp = (a: number): number => Math.min(1, Math.max(0, a))

/** The palette colour at `alpha`, as a paint the canvas still shows through. */
function translucent(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex)
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha)})`
}

/** The same colour at the same alpha, already mixed with the canvas — identical to the eye, opaque. */
function flattened(hex: string, alpha: number, dark: boolean): string {
  const fg = channels(hex)
  const bg = channels(dark ? CANVAS.dark : CANVAS.light)
  const a = clamp(alpha)
  const mix = fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)))
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

const fillAlpha = (dark: boolean): number => (dark ? FILL_ALPHA.dark : FILL_ALPHA.light)

/** The group's background: the picked colour, barely there, and see-through. */
export const softTint = (hex: string, dark: boolean): string => translucent(hex, fillAlpha(dark))

/** The group's border and grab strip: the same colour three times as present, and opaque. */
export const softEdge = (hex: string, dark: boolean): string =>
  flattened(hex, EDGE_FACTOR * fillAlpha(dark), dark)

/**
 * The picker's swatches: the canvas palette, each entry paired with the tint it will actually paint.
 * One array, so the picker and the box cannot drift apart.
 */
export function groupTints(dark: boolean): { color: string; tint: string; edge: string }[] {
  return NODE_COLORS.map((color) => ({
    color,
    tint: softTint(color, dark),
    edge: softEdge(color, dark)
  }))
}

/* --------------------------------------------------------------------------------------------- */
/* The list                                                                                       */
/* --------------------------------------------------------------------------------------------- */

/**
 * Whatever came out of the view store, made safe to draw: a stored section is user data on disk.
 *
 * This is also where the one-group rule is **repaired** rather than enforced: a list written by the
 * version that allowed shared members keeps each process in the *first* group that claims it, and the
 * later groups lose it. Repaired on read and not written back — opening a model must not dirty it —
 * so the healed list reaches disk on the next edit, and until then every read heals it identically.
 */
export function readGroups(raw: unknown): NodeGroup[] {
  if (!Array.isArray(raw)) return []
  const out: NodeGroup[] = []
  const claimed = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const g = item as Partial<NodeGroup>
    if (typeof g.id !== 'string' || !Array.isArray(g.members)) continue
    const members = [...new Set(g.members.filter((m): m is string => typeof m === 'string'))].filter(
      (m) => !claimed.has(m)
    )
    if (!members.length) continue
    for (const m of members) claimed.add(m)
    out.push({
      id: g.id,
      color: typeof g.color === 'string' ? g.color : NODE_COLORS[0],
      members,
      ...(typeof g.label === 'string' && g.label.trim() ? { label: g.label } : {}),
      ...(typeof g.depth === 'number' && Number.isFinite(g.depth) ? { depth: g.depth } : {})
    })
  }
  return out
}

/** An id nothing else in the list uses. Sequential rather than random so a stored view diffs cleanly. */
export function newGroupId(groups: NodeGroup[]): string {
  const used = new Set(groups.map((g) => g.id))
  for (let i = 1; ; i++) {
    const id = `g${i}`
    if (!used.has(id)) return id
  }
}

/** The next palette colour no group is wearing yet. Both routes into a group use this — nobody is
 *  asked for a colour any more — and it falls back to rotating once every colour is in use. */
export function nextGroupColor(groups: NodeGroup[]): string {
  const used = new Set(groups.map((g) => g.color))
  return NODE_COLORS.find((c) => !used.has(c)) ?? NODE_COLORS[groups.length % NODE_COLORS.length]
}

/** What the strip prints. An empty name is never stored, so the fallback is the only other case. */
export const groupLabel = (g: NodeGroup): string => g.label ?? `Group of ${g.members.length}`

/**
 * Take `members` out of every group they are currently in — the one-group rule, in one place.
 *
 * A group emptied by the move disappears; a group down to a single member does not. The user grouped
 * those processes on purpose, and "Add to group" can put something back into a box of one, so an
 * almost-empty box is a usable state rather than a leftover.
 */
function detach(groups: NodeGroup[], members: Iterable<string>): NodeGroup[] {
  const moving = new Set(members)
  const out: NodeGroup[] = []
  let changed = false
  for (const g of groups) {
    const kept = g.members.filter((m) => !moving.has(m))
    if (kept.length === g.members.length) {
      out.push(g)
      continue
    }
    changed = true
    if (kept.length) out.push({ ...g, members: kept })
  }
  return changed ? out : groups
}

/**
 * Add a group. Fewer than two members is not a group, so the list comes back unchanged.
 *
 * A member already in another box **moves** rather than being refused: refusing would need an
 * explanation the user did not ask for ("that one is already in Packaging"), while moving is exactly
 * what somebody who drew a box around it meant. The box it left keeps its remaining members.
 */
export function addGroup(groups: NodeGroup[], members: string[], color: string): NodeGroup[] {
  const unique = [...new Set(members)]
  if (unique.length < 2) return groups
  // The id is taken against the list *before* the move: an id freed by a group the move just emptied
  // would otherwise be handed straight to the new box, and the stored view would read as a rename.
  const id = newGroupId(groups)
  return [...detach(groups, unique), { id, color, members: unique }]
}

/** Put more processes into an existing box. They leave whatever box they were in (see `addGroup`). */
export function addToGroup(groups: NodeGroup[], id: string, members: string[]): NodeGroup[] {
  const target = groups.find((g) => g.id === id)
  if (!target) return groups
  const incoming = [...new Set(members)].filter((m) => !target.members.includes(m))
  if (!incoming.length) return groups
  return detach(groups, incoming).map((g) =>
    g.id === id ? { ...g, members: [...g.members, ...incoming] } : g
  )
}

/**
 * The box an *Add to group* would add to, or `null` when the entry must not be offered.
 *
 * The precondition is read off the **node** selection alone, and deliberately not off "a box is
 * selected and processes are selected" — that state cannot exist, because selecting a box clears the
 * node selection on purpose (a box and a process are different subjects for Delete, the inspector and
 * the brush). So: the selection must touch **exactly one** group and must also carry at least one
 * process that is not in it. Two groups in one selection has no single answer, and a selection wholly
 * inside one box has nothing to add — in both cases the entry stays away instead of guessing.
 */
export function addTarget(groups: NodeGroup[], selection: string[]): NodeGroup | null {
  if (selection.length < 2) return null
  const owners = new Set<string>()
  let outsiders = 0
  for (const id of selection) {
    const owner = groups.find((g) => g.members.includes(id))
    if (owner) owners.add(owner.id)
    else outsiders++
  }
  if (owners.size !== 1 || outsiders === 0) return null
  const [only] = owners
  return groups.find((g) => g.id === only) ?? null
}

/** Ungroup: the box goes, every member stays. Ungrouping can never delete a process. */
export const removeGroup = (groups: NodeGroup[], id: string): NodeGroup[] => groups.filter((g) => g.id !== id)

export const recolorGroup = (groups: NodeGroup[], id: string, color: string): NodeGroup[] =>
  groups.map((g) => (g.id === id ? { ...g, color } : g))

/** Rename a box. A blank name stores nothing — `label` is optional so the box falls back to
 *  "Group of N" rather than printing an empty strip. */
export function renameGroup(groups: NodeGroup[], id: string, label: string): NodeGroup[] {
  const name = label.trim()
  return groups.map((g) => {
    if (g.id !== id) return g
    if (!name) {
      const { label: _dropped, ...rest } = g
      return rest
    }
    return { ...g, label: name }
  })
}

/**
 * Forget nodes that were **deleted** — not nodes that merely left the canvas.
 *
 * Called from the delete paths only. A group whose last member is gone is dropped: an empty box has
 * nothing to say and there is no way to put anything back into it. A group down to one member is
 * kept — the user grouped those processes on purpose, and deleting one of two is no reason to throw
 * the other's grouping away as well.
 */
export function pruneGroups(groups: NodeGroup[], deleted: Iterable<string>): NodeGroup[] {
  const gone = new Set(deleted)
  if (!gone.size) return groups
  const out: NodeGroup[] = []
  let changed = false
  for (const g of groups) {
    const members = g.members.filter((m) => !gone.has(m))
    if (members.length === g.members.length) {
      out.push(g)
      continue
    }
    changed = true
    if (members.length) out.push({ ...g, members })
  }
  return changed ? out : groups
}

/** The group a node belongs to, or `null` — at most one, since `addGroup` moves rather than shares. */
export const groupOf = (groups: NodeGroup[], nodeId: string): NodeGroup | null =>
  groups.find((g) => g.members.includes(nodeId)) ?? null

/* --------------------------------------------------------------------------------------------- */
/* The stack                                                                                      */
/* --------------------------------------------------------------------------------------------- */

/**
 * Paint order for the boxes, back to front: the stored depth, with the bigger rectangle behind on a tie.
 *
 * Depth replaces the old rule, which was area alone — largest first — and produced a bug:
 * a box's title strip crossing into the box above it, with no way to say which of the two
 * should be in front. A box that has never been restacked has no depth and reads as 0, so a view
 * written before this existed keeps exactly the order it had until somebody raises or lowers something.
 */
export function paintOrder<T extends { group: NodeGroup; rect: Rect }>(entries: T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      (a.group.depth ?? 0) - (b.group.depth ?? 0) ||
      b.rect.width * b.rect.height - a.rect.width * a.rect.height
  )
}

/** A node as `groupRect` needs it, read off whatever React Flow currently has.
 *
 *  Structurally typed rather than `Node`, so this module stays free of the canvas library — and
 *  because the fallback matters: a node React Flow has not measured yet (and it never measures in
 *  jsdom, nor offscreen) has no size, and a process card is a fixed 210 px wide (see `.pnode`), so an
 *  unmeasured node still puts the box in the right place. */
const FALLBACK = { width: 210, height: 64 }

export interface MeasuredNode {
  id: string
  hidden?: boolean
  position: { x: number; y: number }
  width?: number | null
  height?: number | null
  measured?: { width?: number | null; height?: number | null }
}

export function nodeBoxes(nodes: readonly MeasuredNode[]): Map<string, NodeBox> {
  const map = new Map<string, NodeBox>()
  for (const n of nodes) {
    if (n.hidden) continue
    map.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      width: n.measured?.width ?? n.width ?? FALLBACK.width,
      height: n.measured?.height ?? n.height ?? FALLBACK.height
    })
  }
  return map
}

/**
 * The boxes that actually get drawn, back to front.
 *
 * One function for both the canvas and the restack, because `restack` swaps against *the order the
 * user is looking at*: if the component sorted and the Workbench worked out the order a second way,
 * "bring forward" would sometimes move the wrong box.
 */
export function drawnGroups(
  groups: NodeGroup[],
  boxes: Map<string, NodeBox>
): { group: NodeGroup; rect: Rect }[] {
  const entries: { group: NodeGroup; rect: Rect }[] = []
  for (const group of groups) {
    const rect = groupRect(group.members, boxes)
    if (rect) entries.push({ group, rect })
  }
  return paintOrder(entries)
}

/**
 * The z-index of the box at `index` in a stack of `count`.
 *
 * Hard constraint: a box is **never** in front of an arrow or a process. React Flow draws
 * both of those at z-index 0 or above, so the whole band sits below zero — the frontmost box is -1 and
 * every one behind it one step lower. That is what makes the invariant arithmetic rather than a habit.
 */
export const groupZ = (index: number, count: number): number => index - count

/**
 * Move one box one step through the stack and write the result back as explicit depths.
 *
 * `order` is the ids as `paintOrder` produced them (back to front) — a swap is only meaningful against
 * the order the user is looking at, which is why the caller passes it rather than this recomputing it
 * from member counts. Every box in that order is given an explicit depth, not just the two that
 * swapped: leaving the rest on the area tie-break would let the next render undo the swap. A box whose
 * members are all off the canvas is not in `order` and is left alone — it has no place in a stack
 * nobody can see, and it re-enters at the depth it was stored with.
 */
export function restack(groups: NodeGroup[], order: string[], id: string, step: 1 | -1): NodeGroup[] {
  const from = order.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= order.length) return groups
  const next = [...order]
  next[from] = order[to]
  next[to] = order[from]
  const depth = new Map(next.map((gid, i) => [gid, i]))
  return groups.map((g) => (depth.has(g.id) ? { ...g, depth: depth.get(g.id) as number } : g))
}

/* --------------------------------------------------------------------------------------------- */
/* Boxes from tags                                                                                */
/* --------------------------------------------------------------------------------------------- */

/** One tag value and the processes carrying it, as the backend partitions a tag group. */
export interface TagPartition {
  value: string
  members: string[]
}

/**
 * One box per tag value, named after the value.
 *
 * The colour comes from the palette rather than from the tag group's own colour, and that is the
 * point: a tag group has **one** colour, so every box would be the same colour and the partition it
 * draws would be unreadable. Values with a single process get no box, by the same rule the Group
 * button follows — a rectangle around one process says nothing — and are reported back so the caller
 * can name them instead of silently dropping them.
 */
export function groupsFromTags(
  groups: NodeGroup[],
  partition: TagPartition[]
): { groups: NodeGroup[]; created: string[]; skipped: string[]; moved: number } {
  let next = groups
  const created: string[] = []
  const skipped: string[] = []
  let moved = 0
  for (const part of partition) {
    const members = [...new Set(part.members)]
    if (members.length < 2) {
      skipped.push(part.value)
      continue
    }
    moved += members.filter((m) => groupOf(next, m)).length
    const before = next
    next = addGroup(next, members, nextGroupColor(next))
    if (next === before) {
      skipped.push(part.value)
      continue
    }
    next = renameGroup(next, next[next.length - 1].id, part.value)
    created.push(part.value)
  }
  return { groups: next, created, skipped, moved }
}

/** Membership follows a node that changed its id (a canvas box whose tags changed, see
 *  lib/occurrences.ts): ``from`` is replaced by ``to`` wherever it is a member. Returns the same array
 *  when nothing changed, so a caller can skip the write. */
export function renameMember(groups: NodeGroup[], from: string, to: string): NodeGroup[] {
  if (!groups.some((g) => g.members.includes(from))) return groups
  return groups.map((g) =>
    g.members.includes(from) ? { ...g, members: g.members.map((m) => (m === from ? to : m)) } : g
  )
}
