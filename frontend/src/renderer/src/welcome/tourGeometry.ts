/**
 * Where the tour's callout goes: the ring around the anchor, the arrow from the card to it, and the note
 * beside it — all in viewport coordinates, and all of it optional.
 *
 * The callout only helps where it can be seen. The card sits in the middle of the window, above
 * everything else, so an anchor that lies under it — the start screen's import tiles on a fresh install
 * sit exactly there — would be ringed behind the card, with no direction for an arrow and the note on top
 * of the card's text. Such an anchor counts as absent, like one that does not exist yet.
 */

/** Where the ring goes: the anchor's box in viewport coordinates, padded. */
export interface Spot {
  top: number
  left: number
  width: number
  height: number
}

/** The arrow: a curve from the card's edge to the ring, plus where the note sits. `path` is null
 *  when card and target nearly touch, `note` when the note would land on the card — see computeArrow. */
export interface Arrow {
  path: string | null
  tip: { x: number; y: number }
  note: { x: number; y: number } | null
}

interface Box {
  top: number
  left: number
  right: number
  bottom: number
}

/** Widest the note is allowed to get; also what keeps it inside the viewport when it is clamped. */
export const NOTE_W = 210
/** Tallest a note gets: two lines of 12 px at 1.35 plus its padding — no note runs to a third at that width. */
const NOTE_H = 48

export const PAD = 8 // breathing room between the ring and the element it rings

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/**
 * The padded ring for an anchor's box, or null when there is nothing worth ringing: a collapsed
 * element (a hidden panel, a zero-height rail during a transition — ringing a 0×0 box draws a dot in a
 * corner), or one the card covers, even in part, since the card is drawn above the ring.
 */
export function spotFor(anchor: DOMRect, card: DOMRect): Spot | null {
  if (anchor.width < 4 || anchor.height < 4) return null
  if (overlaps(anchor, card)) return null
  return {
    top: anchor.top - PAD,
    left: anchor.left - PAD,
    width: anchor.width + PAD * 2,
    height: anchor.height + PAD * 2
  }
}

/**
 * Draw a curve from the nearest point on the card to the nearest edge of the target.
 *
 * "Nearest point on the card" is the target's centre clamped to the card's box, which is the cheap
 * way to get an exit point that always faces the target — the arrow leaves the side you would
 * expect it to, whether the anchor is the rail on the left or the gear at the top right.
 */
export function computeArrow(card: DOMRect, spot: Spot, viewportWidth: number): Arrow {
  const tx = spot.left + spot.width / 2
  const ty = spot.top + spot.height / 2
  const sx = Math.max(card.left, Math.min(tx, card.right))
  const sy = Math.max(card.top, Math.min(ty, card.bottom))
  // Stop at the ring rather than in the middle of the element, so the head points AT the thing.
  const dx = tx - sx
  const dy = ty - sy
  const len = Math.hypot(dx, dy) || 1
  const stop = Math.max(spot.width, spot.height) / 2 + PAD + 10
  const ex = tx - (dx / len) * stop
  const ey = ty - (dy / len) * stop
  // A single control point pushed perpendicular to the line gives the hand-drawn bow of the draft
  // without any of the geometry that a spline would need.
  const bow = Math.min(90, len * 0.28)
  const cx = (sx + ex) / 2 - (dy / len) * bow
  const cy = (sy + ey) / 2 + (dx / len) * bow
  // The note hangs under the ring, aligned to its left edge and clamped into the window — the
  // right-aligned variant used to push it off-screen and cut the last word off. In a small window the
  // card can reach up to just under an anchor at the top; there the note is left out rather than laid
  // over the card's text, and the ring and the arrow point on their own.
  const note = {
    x: Math.max(8, Math.min(spot.left, viewportWidth - NOTE_W - 8)),
    y: spot.top + spot.height + PAD + 8
  }
  const noteBox = { left: note.x, right: note.x + NOTE_W, top: note.y, bottom: note.y + NOTE_H }
  return {
    // A bow needs room. The rail sits some twenty pixels from the card's edge, and a curve drawn
    // across that gap is a smudge, not a pointer — the ring says it better on its own.
    path: len > 70 ? `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}` : null,
    tip: { x: ex, y: ey },
    note: overlaps(noteBox, card) ? null : note
  }
}
