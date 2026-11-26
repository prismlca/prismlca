import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drivingCommands, firstBlock, modelRecipe, shellWords } from './recipe'

describe('shellWords', () => {
  it('splits like a shell', () => {
    expect(shellWords(`type "label=Name" bottle --enter`)).toEqual([
      'type',
      'label=Name',
      'bottle',
      '--enter'
    ])
    expect(shellWords(`wait text "css=.a b" "/^2(\\.0+)? kg/"`)).toEqual([
      'wait',
      'text',
      'css=.a b',
      '/^2(\\.0+)? kg/'
    ])
    expect(shellWords(`read 'document.title'`)).toEqual(['read', 'document.title'])
  })
})

const PAGE = `# Page

## How to get there

\`\`\`sh
node scripts/control-prism.mjs click "not this one"
\`\`\`

## Driving it with control-prism

Text.

\`\`\`sh
node scripts/control-prism.mjs launch --seed
node scripts/control-prism.mjs doctor
node scripts/control-prism.mjs click "title=Add"
# a comment
node scripts/control-prism.mjs type "label=Name" bottle --enter
\`\`\`

\`\`\`sh
node scripts/control-prism.mjs click "the second block"
\`\`\`

## Gotchas
`

describe('the model recipe', () => {
  it('is the first sh block of its section, launch and doctor left to the caller', () => {
    const lines = firstBlock(PAGE, 'Driving it with control-prism')
    expect(lines).toEqual([
      'launch --seed',
      'doctor',
      'click "title=Add"',
      'type "label=Name" bottle --enter'
    ])
    expect(drivingCommands(lines)).toEqual([
      ['click', 'title=Add'],
      ['type', 'label=Name', 'bottle', '--enter']
    ])
  })

  it('refuses a recipe that does more than drive', () => {
    expect(() => drivingCommands(['stop'])).toThrow(/not a command that drives/)
    expect(() => drivingCommands(['click x --no-such-flag'])).toThrow(/unknown flag/)
    expect(() => firstBlock('# nothing\n', 'Driving it with control-prism')).toThrow(/no section/)
  })

  it('reads features/model.md: a model, a process, its CO2 output, GWP100, and the 2 kg result', () => {
    const steps = modelRecipe(join(__dirname, '..', '..'))
    expect(steps[0][0]).toBe('click')
    expect(steps.some((w) => w[0] === 'select' && w[1] === 'LCIA method')).toBe(true)
    expect(steps[steps.length - 1]).toEqual(['wait', 'text', 'css=.result-bar b >> nth=0', '/^2(\\.0+)? kg/'])
  })
})
