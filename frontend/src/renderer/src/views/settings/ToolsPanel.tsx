import { useEffect, useState } from 'react'
import { aiTools, type AiToolInfo } from '../../lib/ai'
import { setAS, useAppSettings } from '../../lib/appSettings'

/** AI-Tools: every tool offered to the assistant, individually switchable. */
export function ToolsPanel(): JSX.Element {
  const [tools, setTools] = useState<AiToolInfo[]>([])
  // Read from the store, not copied — see AiLimitsPanel for why the copies went (18.10.2026).
  const disabled = useAppSettings().disabledTools

  useEffect(() => {
    void aiTools()
      .then(setTools)
      .catch(() => {})
  }, [])

  const toggle = (name: string, on: boolean): void => {
    const next = on ? disabled.filter((n) => n !== name) : [...disabled, name]
    setAS({ disabledTools: next })
  }

  const groups: { group: string; tools: AiToolInfo[] }[] = []
  for (const t of tools) {
    const g = groups.find((x) => x.group === t.group)
    if (g) g.tools.push(t)
    else groups.push({ group: t.group, tools: [t] })
  }

  return (
    <>
      <h4>Assistant tools</h4>
      <p className="settings-hint">
        These tools are offered to the chat assistant. Disabled tools are never shown to the model, so it
        cannot use them.
      </p>
      {groups.map(({ group, tools: list }) => (
        <div key={group} className="ai-tool-group">
          <div className="ai-tool-group-h">{group}</div>
          {list.map((t) => {
            const on = !disabled.includes(t.name)
            return (
              <label key={t.name} className="ai-tool">
                <input type="checkbox" checked={on} onChange={(e) => toggle(t.name, e.target.checked)} />
                <span className="ai-tool-label">{t.label}</span>
                <span className="ai-tool-tech">({t.name})</span>
                {t.hint ? (
                  <span className="ai-tool-info" title={t.hint}>
                    ?
                  </span>
                ) : null}
              </label>
            )
          })}
        </div>
      ))}
    </>
  )
}
