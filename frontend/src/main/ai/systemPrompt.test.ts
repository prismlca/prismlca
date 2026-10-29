import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './systemPrompt'

const base = { activeDb: 'window-study', skills: [] }

describe('buildSystemPrompt', () => {
  it('names the background database instead of saying "ecoinvent"', () => {
    // A model that only ever hears the generic word writes the version and the system model from
    // memory. Measured: the study metadata came out as "Cut-off (ecoinvent APOS)" — two
    // different system models in one field — on a database plainly called `ecoinvent-3.12-cutoff`.
    const p = buildSystemPrompt({ ...base, backgroundDbs: ['ecoinvent-3.12-cutoff', 'biosphere3'] })
    expect(p).toContain('ecoinvent-3.12-cutoff')
    expect(p).toContain('biosphere3')
    // And it has to say what to DO with the name, or it is just another fact in a long prompt.
    expect(p).toMatch(/system model/i)
    expect(p).toMatch(/not interchangeable/i)
  })

  it("introduces the released library as the user's own, with its duties and its limits", () => {
    const p = buildSystemPrompt({ ...base, libraryDbs: ['My processes'] })
    expect(p).toContain('My processes')
    // The three things the model must know: whose data it is, that hits are marked, and that it is
    // NOT vetted background data.
    expect(p).toMatch(/maintains THEMSELF/i)
    expect(p).toMatch(/"library": true/)
    expect(p).toMatch(/not treat it as a[\s\S]*vetted background/i)
  })

  it('says nothing about the library when the chat withheld it', () => {
    const p = buildSystemPrompt({ ...base, libraryDbs: [] })
    expect(p).not.toMatch(/own library/)
  })

  it('says nothing about background databases when none are known', () => {
    const p = buildSystemPrompt(base)
    expect(p).not.toMatch(/background database\(s\) available/)
  })

  it('still names the active model', () => {
    expect(buildSystemPrompt(base)).toContain('window-study')
    expect(buildSystemPrompt({ ...base, activeDb: null })).toContain('none is open')
  })

  it('makes the study language the one source for answers, questions and artifacts (V291)', () => {
    // The old rule governed only the ANSWERS, so one run produced English answers over German
    // process names and German ask_user questions. Deliberately also for the answers: a wrong
    // setting then shows itself in the first reply instead of hiding in the artifacts.
    // Since V418 the language itself travels in the per-turn note (agent.ts), so the rule reads the
    // same with and without a recorded language — that sameness is what keeps the prefix cached.
    const p = buildSystemPrompt({ ...base, studyLanguage: 'de' })
    expect(p).toContain('[Study language: German]')
    expect(p).toMatch(/answers.*ask_user.*process names/s)
    expect(p).not.toMatch(/Answer in the user's language/)
    expect(p).toBe(buildSystemPrompt(base))
  })

  it('tells the model what to do while no language is recorded, and asks for it to be recorded', () => {
    const p = buildSystemPrompt(base)
    expect(p).toContain('[No study language recorded yet]')
    expect(p).toMatch(/record it \(model_info/)
  })

  it('is byte-identical for a new and a continued chat (V418: the title line rides on the user turn)', () => {
    expect(buildSystemPrompt({ ...base, isNewChat: true })).toBe(
      buildSystemPrompt({ ...base, isNewChat: false })
    )
    expect(buildSystemPrompt(base)).not.toContain('set_chat_title')
  })

  it('lists skills by name and description, which is why a dead name there is costly', () => {
    const p = buildSystemPrompt({
      ...base,
      skills: [
        { name: 'Parameters & formulas', description: 'edit_parameter and edit_exchange', content: 'x' }
      ]
    })
    expect(p).toContain('Parameters & formulas')
    expect(p).toContain('edit_parameter and edit_exchange')
    // The body is NOT in the prompt — that is the point of get_skill, and the reason a description
    // is the more dangerous place to name a tool that does not exist.
    expect(p).not.toContain('content')
  })

  it('names the backgrounds switched off for this chat and says so when none is released', () => {
    // Two databases installed, only ecoinvent switched on: the prompt must say BAFU is off, not
    // absent — otherwise the assistant tells the user the data does not exist.
    const p = buildSystemPrompt({
      ...base,
      backgroundDbs: ['ecoinvent-3.12-cutoff'],
      withheldBackgrounds: ['bafu-2026-v1']
    })
    expect(p).toContain('`ecoinvent-3.12-cutoff`')
    expect(p).toContain('switched off for this chat')
    expect(p).toContain('`bafu-2026-v1`')
    const none = buildSystemPrompt({ ...base, backgroundDbs: [], withheldBackgrounds: ['bafu-2026-v1'] })
    expect(none).toContain('No background database is released to this chat')
  })

  it('states the preferred background only when the choice between several actually arises', () => {
    const two = ['ecoinvent-3.12-cutoff', 'bafu-2026-v1']
    // Preferred and released: take it, go elsewhere only without a fit — and say so.
    const pref = buildSystemPrompt({ ...base, backgroundDbs: two, preferredBackground: 'bafu-2026-v1' })
    expect(pref).toMatch(/\*\*prefers `bafu-2026-v1`\*\*/)
    // The preference is carried by this sentence alone. It used to promise that the search marked
    // the hits and listed them first; the code that would have done so never ran, and reviving it
    // was decided against — it would have put a second sorting layer over the
    // backend's common ranking. A prompt must not describe a tool result it does not get.
    expect(pref).toMatch(/read each hit's `database` field/)
    expect(pref).not.toMatch(/"preferred": true/)
    expect(pref).toMatch(/say so in the exchange comment/)
    // Preferred but switched off for this chat: said, not silently dropped.
    const off = buildSystemPrompt({
      ...base,
      backgroundDbs: two,
      withheldBackgrounds: ['ecoinvent-3.12-apos'],
      preferredBackground: 'ecoinvent-3.12-apos'
    })
    expect(off).toMatch(/preferred background `ecoinvent-3.12-apos`[^\n]*does not apply/)
    // No preference: the model chooses deliberately and names the choice.
    const none = buildSystemPrompt({ ...base, backgroundDbs: two })
    expect(none).toMatch(/set no preference/)
    expect(none).toMatch(/name in the exchange comment which database/)
    // One database released: no rule at all — there is nothing to choose between.
    const one = buildSystemPrompt({
      ...base,
      backgroundDbs: ['bafu-2026-v1'],
      preferredBackground: 'bafu-2026-v1'
    })
    expect(one).not.toMatch(/Settings → Modelling|\*\*prefers/)
  })

  it('appends the comparison rule and the briefs last, and says nothing when there is none', () => {
    // Three tiers, because "pay attention to consistency" alone left an unsourced placeholder standing
    // in the other model (measured); the briefs come last so the stable part stays a prefix.
    const brief = '# Comparison model: `pet`\n- **functional_unit**: 500 mL'
    const p = buildSystemPrompt({
      ...base,
      skills: [{ id: 's', name: 'S', description: 'd' }] as never,
      comparisonBriefs: [brief]
    })
    expect(p).toContain('# Comparison model(s)')
    expect(p).toMatch(/Shared assumptions[\s\S]*SAME parameter name/)
    expect(p).toMatch(/never edit the other model yourself/)
    expect(p.indexOf('# Skills available')).toBeLessThan(p.indexOf('# Comparison model(s)'))
    expect(p.endsWith(brief)).toBe(true)
    // The section, not the word: the switch list names the *Comparison models…* entry of the + menu.
    expect(buildSystemPrompt({ ...base, comparisonBriefs: [] })).not.toContain('# Comparison model')
    expect(buildSystemPrompt({ ...base, comparisonBriefs: ['  '] })).not.toContain('# Comparison model')
  })

  it('tells the chat model which switch turns a source on, without naming a tool', () => {
    const text = buildSystemPrompt({ activeDb: 'Model A', skills: [] })
    expect(text).toContain('left of the chat input')
    expect(text).not.toMatch(/research_(web|bom)|eurostat_eol/)
  })
})
