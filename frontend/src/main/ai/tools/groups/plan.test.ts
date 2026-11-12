import { describe, expect, it, vi } from 'vitest'
import type { ChatPlan } from '../../../../shared/plan'
import type { ToolCtx } from '../context'
import { canvasTools } from './canvas'
import { planTools } from './plan'

/**
 * The plan's title when the first call comes without one: the chat's title from `set_chat_title`,
 * else the first step — never a refusal, since the title only heads the plan card.
 */
const setChatTitle = canvasTools.find((t) => t.spec.function.name === 'set_chat_title')!
const plan = planTools[0]

function chatCtx(): { ctx: ToolCtx; saved: ChatPlan[] } {
  let current: ChatPlan | null = null
  const saved: ChatPlan[] = []
  const ctx = {
    ui: vi.fn(async () => ({ ok: true })),
    plan: {
      current: () => current,
      update: async (next: ChatPlan | null) => {
        current = next
        if (next) saved.push(next)
      }
    }
  } as unknown as ToolCtx
  return { ctx, saved }
}

const STEPS = [
  { step: 'Record goal and scope', status: 'in_progress' },
  { step: 'Build widget body process', status: 'pending' }
]

describe('plan title', () => {
  it('heads a title-less first plan with the chat title set earlier in the run', async () => {
    const { ctx, saved } = chatCtx()
    await setChatTitle.run({ title: 'Widget bottle footprint' }, ctx)
    const out = await plan.run({ steps: STEPS }, ctx)
    expect(String(out)).toContain('Plan updated · 0/2')
    expect(saved[0].title).toBe('Widget bottle footprint')
  })

  it('takes the first step when the run named no chat', async () => {
    const { ctx, saved } = chatCtx()
    await plan.run({ steps: STEPS }, ctx)
    expect(saved[0].title).toBe('Record goal and scope')
  })

  it('keeps a title the model sent, and the first title on later calls', async () => {
    const { ctx, saved } = chatCtx()
    await setChatTitle.run({ title: 'Widget bottle footprint' }, ctx)
    await plan.run({ title: 'Widget bottle model', steps: STEPS }, ctx)
    await plan.run(
      {
        steps: [
          { step: 'Record goal and scope', status: 'completed' },
          { step: 'Build widget body process', status: 'in_progress' }
        ]
      },
      ctx
    )
    expect(saved.map((p) => p.title)).toEqual(['Widget bottle model', 'Widget bottle model'])
  })
})
