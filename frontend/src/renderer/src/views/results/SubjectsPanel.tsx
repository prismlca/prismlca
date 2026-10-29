import type { SubjectRef } from '../../lib/subjectKey'
import type { BgSubject, ModelSubject } from './types'

type Setter<T> = (next: T | ((prev: T) => T)) => void

/**
 * The body of the Results rail's "Subjects" group: the model's own processes, its scenarios and baseline,
 * other models' processes and database activities. No state of its own — every value and setter comes from
 * the page (the AccordionGroup stays there, so collapsing unmounts exactly what it unmounted before). The
 * props come as named groups so a swapped `subjSel`/`scenSel` reads wrong at the call site.
 */
export function SubjectsPanel({
  selection,
  colors,
  open,
  libNames,
  activeDb
}: {
  selection: {
    acts: { code: string; name: string }[]
    subjSel: Record<string, boolean>
    setSubjSel: Setter<Record<string, boolean>>
    scenarios: { id: string; name: string }[]
    scenSel: Record<string, boolean>
    setScenSel: Setter<Record<string, boolean>>
    baselineOn: boolean
    setBaselineOn: Setter<boolean>
    shownFg: ModelSubject[]
    setFgSubjects: Setter<ModelSubject[]>
    /** Linked comparison models not in the list yet, and the way to add one (useLinkedModels). */
    linkedModels: string[]
    includeLinked: (model: string) => void
    bgSubjects: BgSubject[]
    setBgSubjects: Setter<BgSubject[]>
  }
  colors: {
    subjectColor: (s: SubjectRef) => string
    scenarioColor: (id: string) => string
    setSubjectColors: Setter<Record<string, string>>
    keyOf: (s: SubjectRef) => string
  }
  open: { addProcess: () => void; addOtherModel: () => void; addDatabase: () => void }
  libNames: Set<string>
  activeDb: string | null
}): JSX.Element {
  const {
    acts,
    subjSel,
    setSubjSel,
    scenarios,
    scenSel,
    setScenSel,
    baselineOn,
    setBaselineOn,
    shownFg,
    setFgSubjects,
    linkedModels,
    includeLinked,
    bgSubjects,
    setBgSubjects
  } = selection
  const { subjectColor, scenarioColor, setSubjectColors, keyOf } = colors
  return (
    <>
      <div className="subj-subhead">Models</div>
      {acts.length ? (
        <div className="subjpick">
          {acts
            .filter((a) => a.code in subjSel)
            .map((a) => (
              <label key={a.code} className="subjrow">
                <input
                  type="checkbox"
                  checked={!!subjSel[a.code]}
                  title="Include in the comparison"
                  onChange={(e) => setSubjSel((s) => ({ ...s, [a.code]: e.target.checked }))}
                />
                <input
                  type="color"
                  className="subj-color"
                  value={subjectColor({ database: activeDb ?? '', code: a.code })}
                  title="Colour for this model in the charts"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setSubjectColors((c) => ({
                      ...c,
                      [keyOf({ database: activeDb ?? '', code: a.code })]: e.target.value
                    }))
                  }
                />
                <span title={a.name}>{a.name}</span>
                <button
                  className="bg-rm"
                  title="Remove from the comparison"
                  onClick={(e) => {
                    e.preventDefault()
                    setSubjSel((sel) => {
                      const next = { ...sel }
                      delete next[a.code]
                      return next
                    })
                  }}
                >
                  ×
                </button>
              </label>
            ))}
          {acts.some((a) => !(a.code in subjSel)) ? (
            <button className="add-flow-btn inline" onClick={() => open.addProcess()}>
              + Add from this model
            </button>
          ) : null}
        </div>
      ) : (
        <p className="empty">No processes in this model yet.</p>
      )}

      {scenarios.length ? (
        <>
          <div className="subj-subhead">Scenarios</div>
          <p className="hint-sm" style={{ margin: '0 0 4px' }}>
            Each one is applied to the model activit
            {Object.values(subjSel).filter(Boolean).length === 1 ? 'y' : 'ies'} selected above.
          </p>
          <div className="subjpick">
            <label className="subjrow" title="The model as it stands, with no parameter overrides">
              <input type="checkbox" checked={baselineOn} onChange={(e) => setBaselineOn(e.target.checked)} />
              <span className="subj-color-gap" aria-hidden="true" />
              <span>Baseline — no overrides</span>
            </label>
            {scenarios.map((s) => (
              <label key={s.id} className="subjrow">
                <input
                  type="checkbox"
                  checked={!!scenSel[s.id]}
                  onChange={(e) => setScenSel((v) => ({ ...v, [s.id]: e.target.checked }))}
                />
                <input
                  type="color"
                  className="subj-color"
                  value={scenarioColor(s.id)}
                  title="Colour for this scenario in the charts"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setSubjectColors((c) => ({ ...c, [s.id]: e.target.value }))}
                />
                <span title={s.name}>{s.name}</span>
              </label>
            ))}
          </div>
        </>
      ) : null}

      <div className="subj-subhead">Other models</div>
      <div className="subjpick">
        {shownFg.map((f) => (
          <span
            key={`${f.database}/${f.code}`}
            className="subjrow bg-subj"
            title={`${f.name} · ${f.database}`}
          >
            <input
              type="checkbox"
              checked={f.enabled !== false}
              title="Include in the comparison"
              onChange={(e) =>
                setFgSubjects((s) =>
                  s.map((x) =>
                    x.database === f.database && x.code === f.code ? { ...x, enabled: e.target.checked } : x
                  )
                )
              }
            />
            <input
              type="color"
              className="subj-color"
              value={subjectColor(f)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSubjectColors((c) => ({ ...c, [keyOf(f)]: e.target.value }))}
            />
            <span>
              {f.name}
              <span className="flow-geo">{f.database}</span>
            </span>
            <button
              className="bg-rm"
              title="Remove"
              onClick={() =>
                setFgSubjects((s) => s.filter((x) => !(x.database === f.database && x.code === f.code)))
              }
            >
              ×
            </button>
          </span>
        ))}
        {linkedModels.map((m) => (
          <label
            key={`linked/${m}`}
            className="subjrow bg-subj"
            title={`${m} is linked as a comparison model of this one. Tick to compare its reference process.`}
          >
            <input type="checkbox" checked={false} onChange={() => includeLinked(m)} />
            <span className="subj-color-gap" aria-hidden="true" />
            <span>
              {m}
              <span className="flow-geo">linked</span>
            </span>
          </label>
        ))}
        <button className="add-flow-btn inline" onClick={() => open.addOtherModel()}>
          + Add from other model
        </button>
      </div>

      <div className="subj-subhead">Datasets</div>
      <div className="subjpick">
        {bgSubjects.map((b) => (
          <span
            key={`${b.database}/${b.code}`}
            className="subjrow bg-subj"
            title={`${b.name}${b.geography ? ` [${b.geography}]` : ''} · ${b.database}`}
          >
            <input
              type="checkbox"
              checked={b.enabled !== false}
              title="Include in the comparison"
              onChange={(e) =>
                setBgSubjects((s) =>
                  s.map((x) =>
                    x.database === b.database && x.code === b.code ? { ...x, enabled: e.target.checked } : x
                  )
                )
              }
            />
            <input
              type="color"
              className="subj-color"
              value={subjectColor(b)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSubjectColors((c) => ({ ...c, [keyOf(b)]: e.target.value }))}
            />
            <span>
              {b.name}
              {b.geography ? <span className="flow-geo">{b.geography}</span> : null}
              {/* Whose dataset: a My-processes subject answers to the same name as an
                  ecoinvent one, and only the source tells the reader whose numbers these are. */}
              {libNames.has(b.database) ? <span className="chip lib">{b.database}</span> : null}
              <span className="bg-amount">
                {b.amount} {b.unit ?? ''}
              </span>
            </span>
            <button
              className="bg-rm"
              title="Remove"
              onClick={() =>
                setBgSubjects((s) => s.filter((x) => !(x.database === b.database && x.code === b.code)))
              }
            >
              ×
            </button>
          </span>
        ))}
        <button className="add-flow-btn inline" onClick={() => open.addDatabase()}>
          + Add from database
        </button>
      </div>
    </>
  )
}
