import { describe, expect, it } from 'vitest'
import { parseArgs } from './args'
import { gesture, InputBroken, parseOffset, parseSteps, pointIn, type Hand } from './drag'
import { describeSeen, type Seen } from './dragSeen'

describe('drag arguments', () => {
  it('reads both targets and the three flags', () => {
    const p = parseArgs([
      'drag',
      'css=.res >> has-text=Test widget',
      'css=.react-flow__pane',
      '--to-offset',
      '120,80',
      '--from-offset=4,4',
      '--steps',
      '3'
    ])
    expect(p.args).toEqual(['css=.res >> has-text=Test widget', 'css=.react-flow__pane'])
    expect(p.flags).toEqual({ 'to-offset': '120,80', 'from-offset': '4,4', steps: '3' })
  })

  it('takes an offset as x,y in pixels, and nothing else', () => {
    expect(parseOffset(undefined, 'to-offset')).toBeUndefined()
    expect(parseOffset('120,80', 'to-offset')).toEqual({ x: 120, y: 80 })
    expect(parseOffset(' 0 , 12.5 ', 'to-offset')).toEqual({ x: 0, y: 12.5 })
    for (const bad of ['120', '120,', '-4,10', '1,2,3', 'left,top', ''])
      expect(() => parseOffset(bad, 'to-offset'), bad).toThrow(/--to-offset takes "x,y"/)
    expect(() => parseOffset(true, 'from-offset')).toThrow(/--from-offset takes "x,y"/)
  })

  it('takes steps from 1 to 100, ten when not given', () => {
    expect(parseSteps(undefined)).toBe(10)
    expect(parseSteps('1')).toBe(1)
    expect(parseSteps('100')).toBe(100)
    for (const bad of ['0', '101', '2.5', 'many', true] as const)
      expect(() => parseSteps(bad), String(bad)).toThrow(/--steps takes a whole number/)
  })
})

describe('pointIn', () => {
  const box = { x: 500, y: 50, width: 1000, height: 800 }

  it('is the centre without an offset, and counts an offset from the top-left corner', () => {
    expect(pointIn(box, undefined, 'css=.pane', 'to-offset')).toEqual({ x: 1000, y: 450 })
    expect(pointIn(box, { x: 0, y: 0 }, 'css=.pane', 'to-offset')).toEqual({ x: 500, y: 50 })
    expect(pointIn(box, { x: 120, y: 80 }, 'css=.pane', 'to-offset')).toEqual({ x: 620, y: 130 })
  })

  it('refuses an offset outside the element, naming its size', () => {
    expect(() => pointIn(box, { x: 1000, y: 10 }, 'css=.pane', 'to-offset')).toThrow(
      '--to-offset 1000,10 lies outside css=.pane, which is 1000×800 px'
    )
    expect(() => pointIn(box, { x: 10, y: 900 }, 'css=.pane', 'from-offset')).toThrow(/--from-offset 10,900/)
  })
})

describe('describeSeen', () => {
  it('says nothing when the window could not say', () => {
    expect(describeSeen(null)).toBe('')
  })

  it('tells a drag without HTML5 from one the page refused', () => {
    expect(describeSeen({ started: false, refused: false, types: [], dropped: false, ended: false })).toMatch(
      /no HTML5 drag started: a drag the page follows with its own pointer handlers, or none$/
    )
    expect(describeSeen({ started: false, refused: true, types: [], dropped: false, ended: true })).toMatch(
      /the page cancelled the HTML5 drag as it started/
    )
  })

  it('names the data of an HTML5 drag and whether the drop was taken', () => {
    const taken = describeSeen({
      started: true,
      refused: false,
      types: ['application/prism-hit'],
      dropped: true,
      ended: true
    })
    expect(taken).toBe(' — an HTML5 drag carrying application/prism-hit; the drop was taken')
    const refused = describeSeen({
      started: true,
      refused: false,
      types: ['text/plain'],
      dropped: false,
      ended: true
    })
    expect(refused).toMatch(/the drop was NOT taken: nothing under the pointer accepted it$/)
  })

  it('says when no dragend reached the page', () => {
    expect(describeSeen({ started: true, refused: false, types: [], dropped: true, ended: false })).toMatch(
      /with no data the page could read; the drop was taken \(and no dragend reached the page\)$/
    )
  })
})

/** A page that records what the gesture does with the pointer and the keyboard; `fail` makes one call fail. */
function fakeHand(fail: { on?: string; hang?: string } = {}): { hand: Hand; calls: string[] } {
  const calls: string[] = []
  const act = (name: string): Promise<void> => {
    calls.push(name)
    if (fail.hang && name.startsWith(fail.hang)) return new Promise(() => undefined)
    if (fail.on && name.startsWith(fail.on)) return Promise.reject(new Error(`${name} failed`))
    return Promise.resolve()
  }
  let evaluations = 0
  const seen: Seen = { started: true, refused: false, types: ['text/plain'], dropped: true, ended: true }
  const hand = {
    mouse: {
      move: (x: number, y: number, o?: { steps?: number }) =>
        act(`move ${x},${y}${o?.steps ? ` in ${o.steps}` : ''}`),
      down: () => act('down'),
      up: () => act('up')
    },
    keyboard: { press: (k: string) => act(`press ${k}`) },
    // The first evaluation installs the watcher, the second reads it.
    evaluate: () => Promise.resolve(evaluations++ === 0 ? undefined : seen)
  } as unknown as Hand
  return { hand, calls }
}

describe('gesture', () => {
  const start = { x: 100, y: 100 }
  const end = { x: 200, y: 100 }

  it('presses, nudges 2 px towards the target, moves across and lets go', async () => {
    const { hand, calls } = fakeHand()
    const seen = await gesture(hand, start, end, 5, 1000)
    expect(calls).toEqual(['move 100,100', 'down', 'move 102,100', 'move 200,100 in 5', 'up'])
    expect(seen?.dropped).toBe(true)
  })

  it('leaves nothing to undo when it fails before the press', async () => {
    const { hand, calls } = fakeHand({ on: 'move 100,100' })
    await expect(gesture(hand, start, end, 5, 1000)).rejects.toThrow('move 100,100 failed')
    expect(calls).toEqual(['move 100,100'])
  })

  it('cancels with Escape before letting go when a move fails with the button down', async () => {
    const { hand, calls } = fakeHand({ on: 'move 200,100' })
    await expect(gesture(hand, start, end, 5, 1000)).rejects.toThrow(
      /the drag broke off with the button down \(move 200,100 in 5 failed\); it was cancelled with Escape/
    )
    expect(calls.slice(-2)).toEqual(['press Escape', 'up'])
  })

  it('lets go also when the press itself fails', async () => {
    const { hand, calls } = fakeHand({ on: 'down' })
    await expect(gesture(hand, start, end, 5, 1000)).rejects.toThrow(/broke off with the button down/)
    expect(calls).toEqual(['move 100,100', 'down', 'press Escape', 'up'])
  })

  it('says the session is broken when the cancel fails too', async () => {
    const { hand, calls } = fakeHand({ on: 'move 200,100' })
    const failing = hand.keyboard as unknown as { press: (k: string) => Promise<void> }
    failing.press = (k: string) => (calls.push(`press ${k}`), Promise.reject(new Error('no keyboard')))
    const run = gesture(hand, start, end, 5, 1000)
    await expect(run).rejects.toBeInstanceOf(InputBroken)
    await expect(run).rejects.toThrow(/cancelling it failed too/)
    expect(calls.slice(-2)).toEqual(['press Escape', 'up'])
  })

  it('says the session is broken when the window stops answering with the button down', async () => {
    const { hand } = fakeHand({ hang: 'move 200,100' })
    const run = gesture(hand, start, end, 5, 50)
    await expect(run).rejects.toBeInstanceOf(InputBroken)
    await expect(run).rejects.toThrow(/drives nothing more until restart/)
  })
})
