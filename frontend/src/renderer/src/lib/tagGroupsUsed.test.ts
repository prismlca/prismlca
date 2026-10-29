import { describe, expect, it } from 'vitest'
import { usedFirst } from './tagGroupsUsed'

const g = (name: string, databases?: string[]) => ({ name, databases })

describe('tag groups, the open model’s first', () => {
  it('lists the groups the model uses first, each half in the workspace’s order, and marks them', () => {
    const out = usedFirst([g('Material'), g('Phase', ['m', 'n']), g('Part'), g('Origin', ['m'])], 'm')
    expect(out.map((x) => [x.name, x.used])).toEqual([
      ['Phase', true],
      ['Origin', true],
      ['Material', false],
      ['Part', false]
    ])
  })

  it('marks nothing without an open model', () => {
    expect(usedFirst([g('Phase', ['m'])], null).map((x) => x.used)).toEqual([false])
  })
})
