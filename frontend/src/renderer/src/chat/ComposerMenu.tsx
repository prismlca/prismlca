import { useEffect, useRef, useState } from 'react'
import { ChartIcon, LinkIcon, RouteIcon } from '../components/icons'
import { distanceAvailability } from '../lib/distance'
import { errMsg } from '../lib/errors'
import { listSkills, updateSkill, type Skill } from '../lib/ai'
import { useAppSettings } from '../lib/appSettings'
import { shortDbLabel } from '../lib/search'
import type { SettingsCategory, SettingsFocus } from '../views/Settings'
import type { ChatPrefs } from './useChatPrefs'

/** The skill glyph — a page of instructions. Heads the Skills row and every skill under it. */
const SKILL_ICON = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </svg>
)

/** A skill name as the flyout shows it: cut at 28 characters, the full name in the tooltip. */
export function shortSkillName(name: string, max = 28): string {
  return name.length > max ? `${name.slice(0, max).trimEnd()}…` : name
}

/**
 * The composer's "+" button and its flyout: attach, the comparison models, and the per-chat switches
 * (web search, distances, Eurostat, the background databases, My processes), with the Skills flyout
 * at the end. Whether it is open is the composer's state — the comparison chip opens it too.
 */
export default function ComposerMenu({
  open,
  setOpen,
  disabled,
  activeDb,
  prefs,
  comparedWith,
  backgroundDbs,
  libraryDbs,
  attaching,
  onAttach,
  onPickComparison,
  onOpenSettings
}: {
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  disabled: boolean
  activeDb: string | null
  prefs: ChatPrefs
  comparedWith: string[]
  backgroundDbs?: string[]
  libraryDbs?: string[]
  attaching: boolean
  onAttach: () => Promise<void>
  onPickComparison: () => void
  onOpenSettings?: (page: SettingsCategory, focus?: SettingsFocus) => void
}): JSX.Element {
  const plusRef = useRef<HTMLDivElement | null>(null)
  // Whether the distances feature can run at all — a geocoding key exists and the app setting is on.
  // Without that the row is not even shown, and main drops the tool from the model's list regardless
  // of what this side sends.
  const [distAvail, setDistAvail] = useState(false)
  // The Skills flyout inside the "+" menu: the same on/off switches as Settings → AI → Skills, a
  // second way to reach them without leaving the chat. Opens on hover (and on click, for keyboards),
  // closes when the pointer leaves — after a short grace so crossing the gap to the flyout does not
  // shut it. The list is fetched each time the menu opens: Settings may have changed it meanwhile.
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const skillsCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Settings → AI Chat can disable web search app-wide; the row then disappears, like Distances and
  // Eurostat below. Read from the app setting, the same one `send` gates on. It once came from a
  // localStorage key nothing writes since settings moved to
  // settings.json, so the row showed "on" while the message went out without web search.
  const webAllowed = useAppSettings().webSearchEnabled !== false
  const transportToolEnabled =
    (useAppSettings().transport as { toolEnabled?: boolean } | undefined)?.toolEnabled ?? true
  const eurostatEnabled = useAppSettings().eurostatEnabled !== false
  // Re-asked whenever the "+" menu opens: a key entered in Settings meanwhile must show up.
  useEffect(() => {
    void distanceAvailability()
      .then((a) => setDistAvail(a.available))
      .catch(() => setDistAvail(false))
  }, [open, transportToolEnabled])

  useEffect(() => {
    if (!open) {
      setSkillsOpen(false)
      setSkillError(null)
      return
    }
    let stale = false
    void listSkills()
      .then((r) => {
        if (!stale) setSkills(r.skills)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [open])

  const toggleSkill = (id: string, enabled: boolean): void => {
    // Server first, like the same switch in Settings: the switch moves when the backend has stored it.
    // It used to move on the click and stay there when the write failed, and two quick clicks could
    // land their re-lists out of order. The round trip is local and short.
    setSkillBusy(true)
    setSkillError(null)
    void updateSkill(id, { enabled })
      .then(
        // The stored skill is the answer: shown at once, so a re-list that fails cannot leave the
        // switch where it was.
        (stored) => setSkills((list) => list.map((s) => (s.id === id ? stored : s))),
        (e) => setSkillError(`Could not change the skill: ${errMsg(e)}`)
      )
      .then(() => listSkills())
      .then((r) => setSkills(r.skills))
      .catch((e) => setSkillError(`Could not reload the skills: ${errMsg(e)}`))
      .finally(() => setSkillBusy(false))
  }
  const holdSkillsOpen = (): void => {
    if (skillsCloseTimer.current) clearTimeout(skillsCloseTimer.current)
    skillsCloseTimer.current = null
    setSkillsOpen(true)
  }
  const releaseSkills = (): void => {
    if (skillsCloseTimer.current) clearTimeout(skillsCloseTimer.current)
    skillsCloseTimer.current = setTimeout(() => setSkillsOpen(false), 150)
  }
  useEffect(
    () => () => {
      if (skillsCloseTimer.current) clearTimeout(skillsCloseTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
    // `setOpen` is the composer's state setter — stable, so this still re-runs on `open` alone.
  }, [open, setOpen])

  return (
    <div className="chat-plus-wrap" ref={plusRef}>
      <button
        className={`chat-attach-btn chat-plus${open ? ' on' : ''}`}
        disabled={disabled}
        aria-label="Attachments and chat options"
        aria-expanded={open}
        title="Attach files, web search, My processes, skills"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open ? (
        <div className="chat-plus-menu" role="menu">
          <button
            className="chat-menu-item"
            role="menuitem"
            disabled={attaching}
            onClick={() => {
              setOpen(false)
              void onAttach()
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            Attach files
          </button>
          {comparedWith.map((name) => (
            <button
              key={name}
              className="chat-menu-item"
              role="menuitemcheckbox"
              aria-checked={!prefs.comparisonOff.includes(name)}
              title={
                prefs.comparisonOff.includes(name)
                  ? `Not briefed on ${name} in this chat`
                  : `The assistant is briefed on ${name} and keeps this model consistent with it`
              }
              onClick={() => prefs.setComparisonOn(name, prefs.comparisonOff.includes(name))}
            >
              <LinkIcon />
              <span className="chat-menu-label">{name}</span>
              <span
                className={`chat-menu-switch${prefs.comparisonOff.includes(name) ? '' : ' on'}`}
                aria-hidden="true"
              >
                <i />
              </span>
            </button>
          ))}
          <button
            className="chat-menu-item"
            role="menuitem"
            disabled={!activeDb}
            title="Link the models this one will be compared with on the Results page"
            onClick={() => {
              setOpen(false)
              onPickComparison()
            }}
          >
            <LinkIcon />
            Comparison models…
          </button>
          {webAllowed ? (
            <button
              className="chat-menu-item"
              role="menuitemcheckbox"
              aria-checked={prefs.webSearch}
              title={
                prefs.webSearch
                  ? 'The assistant may search the web and open links'
                  : 'No web: the assistant answers from what it already knows'
              }
              onClick={() => prefs.setWebSearch((v) => !v)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Web search
              <span className={`chat-menu-switch${prefs.webSearch ? ' on' : ''}`} aria-hidden="true">
                <i />
              </span>
            </button>
          ) : null}
          {distAvail && transportToolEnabled ? (
            <button
              className="chat-menu-item"
              role="menuitemcheckbox"
              aria-checked={prefs.distancesOn}
              title={
                prefs.distancesOn
                  ? 'The assistant may look up road, sea, air and rail distances (openrouteservice / Mapbox, within the limits in Settings → Transport distances)'
                  : 'No distances tool in this chat: the assistant is not even told it exists'
              }
              onClick={() => prefs.setDistancesOn((v) => !v)}
            >
              <RouteIcon />
              Distances
              <span className={`chat-menu-switch${prefs.distancesOn ? ' on' : ''}`} aria-hidden="true">
                <i />
              </span>
            </button>
          ) : null}
          {eurostatEnabled ? (
            <button
              className="chat-menu-item"
              role="menuitemcheckbox"
              aria-checked={prefs.eurostatOn}
              title={
                prefs.eurostatOn
                  ? 'The assistant may look up official end-of-life treatment mixes, packaging and municipal-waste statistics from Eurostat (free, no key)'
                  : 'No Eurostat tool in this chat: the assistant is not even told it exists'
              }
              onClick={() => prefs.setEurostatOn((v) => !v)}
            >
              <ChartIcon />
              Eurostat EoL
              <span className={`chat-menu-switch${prefs.eurostatOn ? ' on' : ''}`} aria-hidden="true">
                <i />
              </span>
            </button>
          ) : null}
          {(backgroundDbs ?? []).map((db) => (
            <button
              key={db}
              className="chat-menu-item"
              role="menuitemcheckbox"
              aria-checked={prefs.isReleased(db)}
              title={
                prefs.isReleased(db)
                  ? `Searches include ${db}`
                  : `${db} is installed but not searched in this chat`
              }
              onClick={() => prefs.toggleBackground(db)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              {shortDbLabel(db)}
              <span className={`chat-menu-switch${prefs.isReleased(db) ? ' on' : ''}`} aria-hidden="true">
                <i />
              </span>
            </button>
          ))}
          {libraryDbs?.length ? (
            <button
              className="chat-menu-item"
              role="menuitemcheckbox"
              aria-checked={prefs.useLibrary}
              title={
                prefs.useLibrary ? 'Searches include your library, marked as yours' : 'Background data only'
              }
              onClick={() => prefs.setUseLibrary((v) => !v)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              My processes
              <span className={`chat-menu-switch${prefs.useLibrary ? ' on' : ''}`} aria-hidden="true">
                <i />
              </span>
            </button>
          ) : null}
          <div className="chat-menu-sub" onMouseEnter={holdSkillsOpen} onMouseLeave={releaseSkills}>
            <button
              className={`chat-menu-item${skillsOpen ? ' open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={skillsOpen}
              title="Which of your skills the assistant is offered — the same switches as Settings → AI → Skills"
              onClick={() => setSkillsOpen((v) => !v)}
            >
              {SKILL_ICON}
              Skills
              <span className="chat-menu-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            {skillsOpen ? (
              <div className="chat-plus-menu chat-submenu" role="menu" aria-label="Skills">
                {skills.length === 0 ? <div className="chat-menu-empty">No skills yet.</div> : null}
                {skillError ? <div className="chat-menu-empty">{skillError}</div> : null}
                {skills.map((s) => (
                  <button
                    key={s.id}
                    className="chat-menu-item"
                    role="menuitemcheckbox"
                    aria-checked={s.enabled}
                    disabled={skillBusy}
                    title={s.description ? `${s.name} — ${s.description}` : s.name}
                    onClick={() => toggleSkill(s.id, !s.enabled)}
                  >
                    {SKILL_ICON}
                    <span className="chat-menu-label">{shortSkillName(s.name)}</span>
                    <span className={`chat-menu-switch${s.enabled ? ' on' : ''}`} aria-hidden="true">
                      <i />
                    </span>
                  </button>
                ))}
                {onOpenSettings ? (
                  <>
                    <div className="chat-menu-divider" role="separator" />
                    <button
                      className="chat-menu-item"
                      role="menuitem"
                      title="Opens Settings → AI → Skills, where a skill is written"
                      onClick={() => {
                        setOpen(false)
                        onOpenSettings('ai-skills', 'add-skill')
                      }}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Add skill
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
