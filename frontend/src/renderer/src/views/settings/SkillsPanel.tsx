import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createSkill, deleteSkill, listSkills, updateSkill, type Skill } from '../../lib/ai'

/** Read-only skill viewer: the full Markdown instructions, rendered. Works for built-ins too.
 *
 *  Rendered through a PORTAL into `document.body`, and that is not cosmetic: the settings sheet lives
 *  under a `.modal-backdrop` whose `backdrop-filter` makes it the containing block for `position: fixed`
 *  descendants, and `.modal.sheet` (`overflow: hidden`) plus `.settings-panel` (`overflow-y: auto`) then
 *  sit between this backdrop and that containing block — so an in-place viewer gets *clipped to the
 *  settings panel's scroll box* instead of covering the window. Portalled out, the viewport is the
 *  containing block again and nothing clips it. */
function SkillViewer({ skill, onClose }: { skill: Skill; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation() // otherwise Escape closes the settings window underneath as well
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal skill-view" onClick={(e) => e.stopPropagation()}>
        <h3>
          {skill.name}
          {skill.builtin ? <span className="ai-skill-badge">built-in</span> : null}
        </h3>
        {skill.description ? <p className="settings-hint skill-view-desc">{skill.description}</p> : null}
        <div className="skill-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.content}</ReactMarkdown>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** AI-Skills: the user's markdown skills offered to the assistant.
 * `focusAdd`: land on the add-a-skill form (the chat's "Add skill" opens this page for exactly that,
 * and the form sits under the list, off-screen once a handful of skills exist). */
export function SkillsPanel({ focusAdd = false }: { focusAdd?: boolean }): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loaded, setLoaded] = useState(false)
  const addRef = useRef<HTMLDivElement | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [viewSkill, setViewSkill] = useState<Skill | null>(null)

  useEffect(() => {
    void refreshSkills()
  }, [])

  const refreshSkills = async (): Promise<void> => {
    const r = await listSkills().catch(() => ({ skills: [] as Skill[] }))
    setSkills(r.skills)
    setLoaded(true)
  }
  // Scroll only once the list has rendered: before that the form is at the top of an empty panel and
  // the list then pushes it back out of view.
  useEffect(() => {
    if (!focusAdd || !loaded || !addRef.current) return
    addRef.current.scrollIntoView?.({ block: 'end' })
    addRef.current.querySelector('input')?.focus()
  }, [focusAdd, loaded])

  const onFile = async (f: File | null): Promise<void> => {
    if (!f) return
    const text = await f.text()
    setContent(text)
    setFileName(f.name)
    if (!name) setName(f.name.replace(/\.(md|markdown|txt)$/i, ''))
  }
  const addSkill = async (): Promise<void> => {
    if (!name.trim() || !content.trim()) return
    await createSkill(name.trim(), desc.trim(), content).catch(() => {})
    setName('')
    setDesc('')
    setContent('')
    setFileName('')
    await refreshSkills()
  }

  return (
    <>
      <h4>Skills</h4>
      <p className="settings-hint">
        Markdown instructions offered to the assistant. Say what each skill is for.
      </p>
      <div className="ai-skills">
        {skills.length === 0 ? <div className="ai-skill-empty">No skills yet.</div> : null}
        {skills.map((s) => (
          <div key={s.id} className="ai-skill">
            <label className="ai-skill-on" title="Offer to the assistant">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => void updateSkill(s.id, { enabled: e.target.checked }).then(refreshSkills)}
              />
            </label>
            <button
              className="ai-skill-meta"
              title="View the full instructions"
              onClick={() => setViewSkill(s)}
            >
              <div className="ai-skill-name">
                {s.name}
                {s.builtin ? (
                  <span
                    className="ai-skill-badge"
                    title="Ships with PrismLCA — can be disabled, but not edited or deleted."
                  >
                    built-in
                  </span>
                ) : null}
              </div>
              {s.description ? <div className="ai-skill-desc">{s.description}</div> : null}
            </button>
            {s.builtin ? null : (
              <button
                className="ai-skill-del"
                title="Delete skill"
                onClick={() => void deleteSkill(s.id).then(refreshSkills)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="ai-skill-add" ref={addRef}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="What / when to use it for?"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <label className="ai-skill-file">
          <input
            type="file"
            accept=".md,.markdown,.txt"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
          <span>{fileName || 'Choose a Markdown file…'}</span>
        </label>
        <button
          className="btn sm primary"
          disabled={!name.trim() || !content.trim()}
          onClick={() => void addSkill()}
        >
          Add
        </button>
      </div>
      {viewSkill ? <SkillViewer skill={viewSkill} onClose={() => setViewSkill(null)} /> : null}
    </>
  )
}
