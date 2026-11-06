import { describe, expect, it } from 'vitest'
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, oneLine, skillListing } from './skillListing'
import { TOOL_BY_NAME } from './tools'

const skill = (name: unknown, description: unknown): never =>
  ({ name, description, content: 'body' }) as never

describe('skillListing', () => {
  it('lists an ordinary skill exactly as written', () => {
    const skills = [
      skill(
        'Parameters & formulas',
        'What per-model parameters and exchange formulas are for (edit_parameter).'
      ),
      skill('Bill of materials from a product description', 'Use when the user describes a product.'),
      skill('House style', '')
    ]
    expect(skillListing(skills)).toBe(
      '- **Parameters & formulas** — What per-model parameters and exchange formulas are for (edit_parameter).\n' +
        '- **Bill of materials from a product description** — Use when the user describes a product.\n' +
        '- **House style** — (no description)'
    )
  })

  it('puts every skill on one line, whatever breaks its name or description holds', () => {
    const text = skillListing([
      skill('Two\nlines', 'first\r\n\n# Heading\n- bullet'),
      skill('Separators', 'a\u2028b\u2029c\u0085d\ve\ff')
    ])
    expect(text.split('\n')).toEqual([
      '- **Two lines** — first # Heading - bullet',
      '- **Separators** — a b c d e f'
    ])
  })

  it('caps a long name or description at a word boundary', () => {
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
    const name = oneLine(words(60), SKILL_NAME_MAX)
    const description = oneLine(words(400), SKILL_DESCRIPTION_MAX)
    expect(Array.from(name).length).toBeLessThanOrEqual(SKILL_NAME_MAX)
    expect(Array.from(description).length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX)
    expect(name.endsWith('…') && description.endsWith('…')).toBe(true)
    // Every word that is left is a whole word of the original, so a lookup by name still finds it.
    for (const w of name.slice(0, -1).split(' ')) expect(words(60).split(' ')).toContain(w)
    // One unbroken run is cut where the cap is, never in the middle of a character.
    const run = oneLine('😀'.repeat(SKILL_NAME_MAX + 5), SKILL_NAME_MAX)
    expect(Array.from(run)).toHaveLength(SKILL_NAME_MAX)
    expect(run.endsWith('😀…')).toBe(true)
  })

  it('takes what is not a string as text', () => {
    expect(skillListing([skill(42, null)])).toBe('- **42** — (no description)')
  })

  it('reads a long run of blanks once', () => {
    const started = Date.now()
    expect(oneLine(`${' '.repeat(200_000)}x${'\t '.repeat(100_000)}`, SKILL_DESCRIPTION_MAX)).toBe('x')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('leaves a cut name one that get_skill still finds', async () => {
    const full =
      'Packaging end-of-life rates for Germany, Austria and Switzerland from the national waste statistics ' +
      'of 2019 to 2023 and the Eurostat tables'
    const listed = oneLine(full, SKILL_NAME_MAX)
    expect(listed).not.toBe(full)
    const out = JSON.parse(
      (await TOOL_BY_NAME.get_skill.run({ name: listed }, {
        api: async () => ({
          skills: [
            { id: 'p', name: full, description: 'd', content: 'c' },
            { id: 'q', name: 'Interpreting results', description: 'd', content: 'c' }
          ]
        }),
        ui: async () => ({}),
        activeDb: 'm'
      } as never)) as string
    )
    expect(out.name).toBe(full)
  })

  it('gives a changed name the id to load it by, so two cut names cannot be confused', async () => {
    const stem =
      'Packaging end-of-life rates for Germany, Austria and Switzerland from the national waste statistics ' +
      'and the Eurostat tables, reference year'
    const skills = [
      { id: 'a1b2c3d4e5f6', name: `${stem} 2019`, description: 'old', content: 'the 2019 rates' },
      { id: 'f6e5d4c3b2a1', name: `${stem} 2023`, description: 'new', content: 'the 2023 rates' },
      { id: 'c0ffee000000', name: 'Interpreting results', description: 'd', content: 'c' }
    ]
    const lines = skillListing(skills).split('\n')
    expect(lines[0].split(' (`get_skill`')[0]).toBe(lines[1].split(' (`get_skill`')[0])
    expect(lines[0]).toContain('(`get_skill` name: `a1b2c3d4e5f6`)')
    expect(lines[1]).toContain('(`get_skill` name: `f6e5d4c3b2a1`)')
    expect(lines[2]).toBe('- **Interpreting results** — d')
    const out = JSON.parse(
      (await TOOL_BY_NAME.get_skill.run({ name: 'f6e5d4c3b2a1' }, {
        api: async () => ({ skills }),
        ui: async () => ({}),
        activeDb: 'm'
      } as never)) as string
    )
    expect(out.content).toBe('the 2023 rates')
    // An id that is not one plain token is left out rather than printed.
    expect(skillListing([{ id: 'x`\ny', name: 'a\nb', description: 'd', content: '' }])).toBe('- **a b** — d')
  })
})
