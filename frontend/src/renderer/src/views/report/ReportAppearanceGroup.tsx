import { AccordionGroup } from '../../components/Accordion'
import PalettePicker, { resolvePalette, usePalettes } from '../PalettePicker'
import ThemeGallery from '../ThemeGallery'
import type { StoredReportFull } from '../../lib/report/model'

/** Colours and theme — everything about the look, in the order the two questions are answered
 * (own component since wave 3.1). */
export default function ReportAppearanceGroup({
  report,
  grp,
  templates,
  mutate,
  base,
  onTemplatesChanged
}: {
  report: StoredReportFull
  grp: { open: boolean; onToggle: () => void }
  templates: { name: string; label?: string; builtin?: boolean }[]
  mutate: (method: string, path: string, body?: object) => Promise<boolean>
  base: string
  /** A deleted theme moves every report that used it back to the default — the caller re-reads. */
  onTemplatesChanged: () => Promise<void>
}): JSX.Element {
  const { list: paletteList } = usePalettes()
  const shown = resolvePalette(paletteList, report.palette ?? '')
  const paletteLabel = shown?.label ?? ''
  return (
    <AccordionGroup
      title="Appearance"
      /* Both answers the group holds, in the order the body asks them — the colour set is as much of
           "what the document looks like" as the theme is, and while closed this line is all there is. */
      summary={[paletteLabel, templates.find((t) => t.name === report.template)?.label ?? report.template]
        .filter(Boolean)
        .join(' · ')}
      {...grp}
    >
      {/* Everything about the look, here rather than behind a window: the group has the room, and a
            window you open and close again to change a theme is a window in the way.

            Two questions, in the order they are answered: the colours first, because they repaint every
            cover in the gallery below — picking a theme from tiles that are all still green and then having
            them change under you is the wrong way round. */}
      <PalettePicker
        selected={report.palette ?? ''}
        onSelect={(id) => void mutate('POST', base, { palette: id })}
        colors={report.palette_colors}
        onColors={(next) => void mutate('POST', base, { palette_colors: next })}
      />
      <div className="sub-label">Theme</div>
      <ThemeGallery
        themes={templates}
        // The set the document is actually typeset in: a set of your own that was deleted falls back to
        // the default, and the covers have to follow rather than keep the deleted set's cached pictures.
        palette={shown?.id ?? report.palette ?? ''}
        colors={report.palette_colors}
        selected={report.template}
        onSelect={(name) => void mutate('POST', base, { template: name })}
        onChanged={() => void onTemplatesChanged()}
      />
    </AccordionGroup>
  )
}
