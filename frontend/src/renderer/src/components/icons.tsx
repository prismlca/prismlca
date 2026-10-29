/**
 * Shared inline SVG icons (stroke = currentColor so they follow the button's text colour).
 *
 * Most path data is Feather Icons (https://feathericons.com), MIT licence, Copyright (c) 2013-2023 Cole
 * Bemis. A few icons are Lucide's or drawn after Lucide (https://lucide.dev), ISC licence, Copyright (c)
 * Lucide Icons and Contributors; the rest are drawn here. Both licences ask that their notice travel with
 * the software: the full texts are in THIRD-PARTY-NOTICES.md ("Icons and logos"), which ships with every
 * installer. Every icon's comment names its source, and an icon from a set not listed there waits until
 * that set's notice is in.
 */

const svgProps = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

export function GearIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function UndoIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
    </svg>
  )
}

/**
 * Undo, struck through — "this cannot be taken back".
 *
 * The same arrow as {@link UndoIcon} so the two read as one vocabulary, with the prohibition stroke
 * over it. One glyph rather than two stacked ones: the audit row has room for a mark beside its
 * source label, not for a pair. The slash carries a background-coloured casing underneath so it
 * stays legible where it crosses the arrow, which a bare line does not at 13 px.
 */
export function NoUndoIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={15} height={15}>
      {/* The arrow steps back so the bar reads first: at this size the eye has room for one mark,
          and the one that has to land is "not". */}
      <g opacity={0.55}>
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
      </g>
      <path d="M4 20 20 4" stroke="var(--surface-2)" strokeWidth={5} strokeLinecap="butt" />
      <path d="M4 20 20 4" strokeWidth={2.4} />
    </svg>
  )
}

export function RedoIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h4" />
    </svg>
  )
}

// Toolbar button icons.
/** Three boxes wired together — a model is a node network, and the boxes echo the canvas nodes.
 * Kept square on purpose so it stays apart from the round nodes of BranchIcon (Scenarios). */
export function ModelIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="9" y="2" width="6" height="6" rx="1.5" />
      <rect x="2" y="16" width="6" height="6" rx="1.5" />
      <rect x="16" y="16" width="6" height="6" rx="1.5" />
      <path d="M12 8v3" />
      <path d="M5 16v-3.5A1.5 1.5 0 0 1 6.5 11h11a1.5 1.5 0 0 1 1.5 1.5V16" />
    </svg>
  )
}

/**
 * "New model" and "new activity" for a toolbar too narrow for the words: with the
 * framed plus alone, the two buttons side by side looked the same. A small plus beside the thing it
 * creates — the model tree, or one process box. Wider than the others (34 × 24), so the symbol keeps
 * its usual size next to the plus.
 */
export function NewModelIcon(): JSX.Element {
  return (
    <svg {...svgProps} viewBox="0 0 34 24" width={23}>
      <path d="M4 9v6M1 12h6" />
      <rect x="19" y="2" width="6" height="6" rx="1.5" />
      <rect x="12" y="16" width="6" height="6" rx="1.5" />
      <rect x="26" y="16" width="6" height="6" rx="1.5" />
      <path d="M22 8v3" />
      <path d="M15 16v-3.5a1.5 1.5 0 0 1 1.5-1.5h11a1.5 1.5 0 0 1 1.5 1.5V16" />
    </svg>
  )
}

export function NewActivityIcon(): JSX.Element {
  return (
    <svg {...svgProps} viewBox="0 0 34 24" width={23}>
      <path d="M4 9v6M1 12h6" />
      <rect x="12" y="5" width="20" height="14" rx="3" />
      <path d="M12 9.5h20M16 14h8" />
    </svg>
  )
}

/** The plus in a rounded square: the mark of every button that creates something — a model, an activity,
 *  a scenario, a parameter, a figure. The bare `PlusIcon` is for zoom-in and the
 *  small inline add buttons, where a framed plus would read as a checkbox. */
export function AddIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  )
}

export function TagIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M20.59 13.41 12 22l-9-9V3h10l7.59 7.59a2 2 0 0 1 0 2.82Z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </svg>
  )
}

export function InfoIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

/** Lucide "calculator" — the shared look of every Calculate button. */
export function CalculatorIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="16" y1="14" x2="16" y2="18" />
      <path d="M16 10h.01" />
      <path d="M12 10h.01" />
      <path d="M8 10h.01" />
      <path d="M12 14h.01" />
      <path d="M8 14h.01" />
      <path d="M12 18h.01" />
      <path d="M8 18h.01" />
    </svg>
  )
}

export function CopyIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function TrashIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

export function PencilIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

export function HighlightIcon(): JSX.Element {
  // Flashlight (Taschenlampe) — the tool that lights up processes carrying a chosen tag.
  return (
    <svg {...svgProps}>
      <path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z" />
      <path d="M6 6h12" />
      <path d="M12 12h.01" />
    </svg>
  )
}

/** Four-way arrows (Feather "move") — the canvas hand tool: a left-drag pans instead of selecting. */
export function PanIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  )
}

/** Arrow pointer (Feather "mouse-pointer") — shown on the hand tool while it is on: click to get it back. */
export function PointerIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      <path d="M13 13l6 6" />
    </svg>
  )
}

/** Sort: three left-aligned bars that grow shorter, a down arrow to their right — the label of the flow
 *  lists' sort control, not a button. Drawn here: Feather has no sort glyph. */
export function SortIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={13} height={13}>
      <path d="M3 6h10" />
      <path d="M3 12h7" />
      <path d="M3 18h4" />
      <path d="M18 4v15" />
      <path d="M14.5 15.5 18 19l3.5-3.5" />
    </svg>
  )
}

/** Maximize/enlarge icon: opens a chart in an overlay at full size. */
/** Zoom in / out. Bare plus and minus, matching the canvas's own zoom controls rather than a magnifier —
 *  the two sit next to each other in the app and should read as the same control. */
export function PlusIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

/** The stop square off a tape deck — what "give up on the running job" looks like everywhere else.
 *  Filled, because a hollow square in a row of stroked icons reads as an empty checkbox. */
export function StopIcon(): JSX.Element {
  return (
    <svg {...svgProps} fill="currentColor" strokeWidth={0}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}

export function MinusIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M5 12h14" />
    </svg>
  )
}

export function MaximizeIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

/** Lucide "bar-chart-3" (its earlier form, square axes) — the Results view and the "save all charts" export. */
export function ChartIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  )
}

/** Feather "repeat" — "change provider" in the chat's model menu. */
export function SwapIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

/** Feather "bar-chart": three bars, short–medium–tall — reasoning effort in the chat's model menu. */
export function EffortIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  )
}

/** Spreadsheet file with an X — the Excel export button. */
export function ExcelIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="m9.3 12.5 5.4 6" />
      <path d="m14.7 12.5-5.4 6" />
    </svg>
  )
}

/** Monochrome padlock — replaces the coloured 🔒 emoji for read-only / locked markers. Sized in
 * `em` so it follows the surrounding text. */
export function LockIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-0.13em' }}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

/** Feather "unlock" — the open padlock beside `LockIcon`, for a lock that can be closed. Sized in `em`
 * like its pair, so the two swap in place without the button changing size. */
export function UnlockIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-0.13em' }}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  )
}

/** Monochrome magnifier — replaces the coloured 🔍 emoji in search entry points. Sized in `em`. */
/** The four-pointed sparkle that means "a model did this" everywhere else in software. Filled,
 *  not stroked: at 13 px a stroked star is a smudge, and this one has to read at button size. */
export function SparkleIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      // Bigger than the 1em the other icons use: this one is a mark, not a glyph beside a word —
      // it says "a model did this", and at 1em it read as a speck.
      width="1.25em"
      height="1.25em"
      fill="currentColor"
      aria-hidden
      style={{ verticalAlign: '-0.13em' }}
    >
      {/* Concave sides, so the four points are fat at the base and sharp at the tip — a thin star
          reads as a speck at button size. The small one keeps it from looking like a compass rose. */}
      <path d="M10 1c1.2 5.4 3.6 7.8 9 9-5.4 1.2-7.8 3.6-9 9-1.2-5.4-3.6-7.8-9-9 5.4-1.2 7.8-3.6 9-9Z" />
      <path d="M18 12.4c.66 3.3 1.74 4.38 5.04 5.04-3.3.66-4.38 1.74-5.04 5.04-.66-3.3-1.74-4.38-5.04-5.04 3.3-.66 4.38-1.74 5.04-5.04Z" />
    </svg>
  )
}

/** Feather "search". Sized in em so it follows the text of the field or button it sits in. (The handle was
 *  Lucide's path, a hair shorter; Feather's own line is the same picture under the notice we ship.) */
export function SearchIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-0.13em' }}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

/** Import (tray + down-arrow, Feather "download") — every "take something in from a file" action: a
 *  model, processes, background data, scenarios, a workspace backup. The arrow points into the tray
 *  because the data arrives; an arrow leaving the tray reads as export. */
export function ImportIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

/* Sidebar navigation icons — one per study page. Model reuses ModelIcon, Results reuses
 * ChartIcon; the rest live here. */

/** House — the Overview page, the app's landing spot. */
export function HomeIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 21v-7h6v7" />
    </svg>
  )
}

/** Mixer sliders — the Parameters page. */
export function SlidersIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </svg>
  )
}

/** Splitting path — the Scenarios page: one model, several variants. */
export function BranchIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <path d="M6 7.5v9" />
      <path d="M6 12h6a3 3 0 0 1 3 3v1.8" />
    </svg>
  )
}

/** Lab flask, after Lucide "flask-conical" — the LCIA page, where impact is assessed. */
export function FlaskIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M10 2v6.3L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 8.3V2" />
      <path d="M8.5 2h7" />
      <path d="M7 14h10" />
    </svg>
  )
}

/** Document with text lines — the Report page. */
export function ReportIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  )
}

/** Floppy-disk save icon used by every chart's save-as-PNG button. */
export function SaveIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

/** Folder — the model list's grouping. Drawn as a tab and a body rather than one closed shape, so
 *  it still reads at 16 px, where a folded-corner folder turns into a blob.
 *
 *  Sized against its neighbours, not against the box: the first version filled 13.8 of the 24 grid
 *  units in height while `AddIcon` and `ImportIcon` beside it fill 18, and next to them it
 *  simply looked smaller. A folder is wider than it is tall, so it does not go
 *  to a full 18 — 15.8 is as far as the shape carries without turning into a box. */
export function FolderIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M3 6.2a2 2 0 0 1 2-2h4.1l2.1 2.5H19a2 2 0 0 1 2 2v9.3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

/** Folder with a plus — "make another one". The plus sits inside the body, not beside the icon,
 *  because the toolbar row is tight and two glyphs read as two buttons. */
export function FolderPlusIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M3 6.2a2 2 0 0 1 2-2h4.1l2.1 2.5H19a2 2 0 0 1 2 2v9.3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11.6v5.6" />
      <path d="M9.2 14.4h5.6" />
    </svg>
  )
}

/** Disclosure chevron. Points right when closed and is rotated by CSS when open, so the turn is a
 *  transition rather than two different glyphs swapping places. */
export function ChevronIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={14} height={14}>
      <path d="M9 5.5 15.5 12 9 18.5" />
    </svg>
  )
}

/* The four transport modes of the Distances panel, one glyph each so the mode reads at a glance and
   the recent-lookups list needs no word for it. Same stroke grammar as the rest of the set. */
export function TruckIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M1 3h15v13H1z" />
      <path d="M16 8h4l3 3v5h-7z" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  )
}

export function ShipIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M2 20c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0" />
      <path d="M4 17l-1-5 9-3 9 3-1 5" />
      <path d="M8 9V5h8v4" />
      <path d="M12 2v3" />
    </svg>
  )
}

/** Lucide "plane" — air transport in the Distances panel. */
export function PlaneIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  )
}

export function TrainIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="4" y="3" width="16" height="14" rx="3" />
      <path d="M4 10h16" />
      <path d="M8 21l2-4M16 21l-2-4" />
      <circle cx="8.5" cy="13.5" r="1" />
      <circle cx="15.5" cy="13.5" r="1" />
    </svg>
  )
}

/** Two pins and the way between them, after Lucide "route" — the toolbar's Distances button. */
export function RouteIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <circle cx="6" cy="19" r="3" />
      <circle cx="18" cy="5" r="3" />
      <path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12" />
    </svg>
  )
}

/** Two chain links — a model linked to the one it is compared with (the comparison-model entry in
 *  the chat's "+" menu, its chip in the composer, and the row in the model's Info dialog). One icon
 *  for the whole concept. */
export function LinkIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

/** Feather "clock" — a message typed while the run works, waiting for its turn (the queued chip in
 *  the composer). Replaced the ⏳ emoji, which the system emoji font drew in colour. */
export function ClockIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={13} height={13}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

/** History: the circling arrow of Feather "rotate-ccw" round the hands of Feather "clock" — the audit
 *  log's heading. Feather has no history glyph, so this one is put together from two of its paths. */
export function HistoryIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={13} height={13}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

/** Feather "message-square" — the comment on a flow: in the inspector's flow rows and the process details
 *  window. One icon for the concept, whether the comment can be written or only read. */
export function CommentIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={13} height={13}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/** Feather "paperclip" — a file attached to a chat message, in the composer and in the sent turn. */
export function PaperclipIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={13} height={13}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

/** Feather "alert-triangle" — an attachment that could not be read; the chip colours it. */
export function AlertIcon(): JSX.Element {
  return (
    <svg {...svgProps} width={13} height={13}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/** A pane with an arrow leaving it — every control that hands the job to the real browser. One
 *  icon for the whole idea, so "this leaves PrismLCA" never has to be written out in a label. */
export function ExternalLinkIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  )
}

/** Feather "arrow-up-right" — a process the assistant names, as a jump to it on the canvas. Not
 *  ExternalLinkIcon: that one says "this leaves PrismLCA", and the jump stays in the app. */
export function ArrowUpRightIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  )
}

/** A slim right arrow after a text link that opens more (the inspector's Details and Properties),
 *  drawn here rather than taken from Feather: a shaft and a head of two open strokes, in pixel units
 *  at a 1px line, about the cap height of the link's 10.5px text. The head's strokes are 3px each
 *  way — shorter, they ran together into a triangle at 1x. */
export function ArrowRightIcon(): JSX.Element {
  return (
    <svg {...svgProps} viewBox="0 0 10 7" width={10} height={7} strokeWidth={1}>
      <path d="M0.5 3.5h9" />
      <path d="M6.5 0.5 9.5 3.5 6.5 6.5" />
    </svg>
  )
}

/** The stacked cylinder every piece of software draws for a database — the background databases on
 *  the overview. Deliberately the cliché: it is read, not looked at. */
export function DatabaseIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
      <path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  )
}

/** Two arrows, one out and one back, after Lucide "arrow-right-left" — an exchange, which is what an
 *  elementary flow is: what a process takes from nature and what it gives back to it. The same arrows
 *  the canvas and the Sankey use for a flow, rather than a leaf standing in for "nature". */
export function FlowIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M3 8h14" />
      <path d="m14 5 3 3-3 3" />
      <path d="M21 16H7" />
      <path d="m10 13-3 3 3 3" />
    </svg>
  )
}

/** A folded newspaper — the project's news, opened on the website. */
export function NewsIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M4 5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v14H6a2 2 0 0 1-2-2z" />
      <path d="M17 8h2a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2" />
      <path d="M8 8h5M8 12h5M8 16h3" />
    </svg>
  )
}

/** An envelope, after Lucide "mail" — the newsletter box on the overview. */
export function MailIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.6 7 7.5 5.2a1.6 1.6 0 0 0 1.8 0L20.4 7" />
    </svg>
  )
}

/** A compass with its needle — the guided first-start tour, and the way back into it. */
export function CompassIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z" />
    </svg>
  )
}

/* The two marks the splash window sets beside the same two facts, so the overview's footer and the
 * window you see before it say the same thing the same way. The path data is
 * copied from main/splash.ts, which cannot import from here — it builds its HTML as a string. */

/** A shipping box — the version. */
export function PackageIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

/** Head and shoulders — the person behind the app. */
export function UserIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

/** A panel with its left column marked off — the rail's fold/unfold button. One glyph for both
 *  directions (claude.ai and Gemini do the same): the button's `title` says which way it goes, and
 *  a mirrored twin would only ask the reader to tell two near-identical rectangles apart. */
export function SidebarIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

/** The licence (AGPL-3.0) beside version and lead developer — a text document; the splash draws the same shape. */
export function LicenceIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  )
}

/** Feather "globe" — the language settings (spell-check dictionaries). */
export function GlobeIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

/** Feather "refresh-cw" — the start page's way to the update check in Settings → About. */
export function UpdateIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

/** Feather "check" — confirms a choice made in a small inline control, such as the chapter kind picked
 *  under the report's chapter list. */
export function CheckIcon(): JSX.Element {
  return (
    <svg {...svgProps}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
