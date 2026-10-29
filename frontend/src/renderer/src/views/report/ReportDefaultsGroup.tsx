import { AccordionGroup } from '../../components/Accordion'
import type { StoredReportFull } from '../../lib/report/model'

/** The workspace's starting structure for new reports: store this report's chapter list as it, or go back
 * to the built-in one (own component since wave 3.1). */
export default function ReportDefaultsGroup({
  report,
  grp,
  mutate
}: {
  report: StoredReportFull
  grp: { open: boolean; onToggle: () => void }
  mutate: (method: string, path: string, body?: object) => Promise<boolean>
}): JSX.Element {
  return (
    <AccordionGroup title="Defaults" summary="workspace template" {...grp}>
      <p className="settings-hint">
        Store this chapter list so that new reports in the workspace start from it, or go back to the built-in
        structure.
      </p>
      <div className="rsec-add">
        <button
          className="btn sm"
          title="Every new report in this workspace starts with this structure. Reports that already exist stay as they are."
          onClick={() =>
            void mutate('POST', '/api/v1/report/defaults', {
              sections: report.sections.map((x) => ({
                kind: x.kind,
                title: x.title,
                prompt_override: x.prompt_override,
                extra_instructions: x.extra_instructions
              }))
            })
          }
        >
          Set as workspace default
        </button>
        <button
          className="btn sm"
          title="Back to the built-in ISO 14044 structure for new reports"
          onClick={() => void mutate('POST', '/api/v1/report/defaults', { sections: [] })}
        >
          Reset default
        </button>
      </div>
    </AccordionGroup>
  )
}
