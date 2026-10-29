/**
 * The `plan` tool: the checklist the assistant keeps beside the chat on long tasks.
 * No backend call — it writes the chat's plan through
 * `ctx.plan`, which the chat loop injects and the MCP server does not (the external client is the
 * model and brings its own task list; `plan` is in MCP_EXCLUDED_TOOLS for that reason).
 *
 * The rules live in shared/plan.ts and are enforced with a diagnostic sentence, never by bending the
 * schema: two steps `in_progress`, a `blocked` step without a reason, an unfinished step quietly
 * dropped — each comes back as a refusal that says what to send instead, and the previous accepted
 * revision stays in force. The description below is deliberately short (Codex's shape); the
 * behavioural rules — when to plan at all, tick off immediately, never on intent — are the system
 * prompt's job, so a model that does not see the tool does not see the rules either.
 */

import type { Tool } from '../context'
import { obj, str } from '../schema'
import { S } from '../format'
import {
  PLAN_LIMITS,
  PLAN_STATUSES,
  formatPlanForModel,
  planProgress,
  validatePlanUpdate
} from '../../../../shared/plan'

export const planTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'plan',
        description: `Keep the task plan the user sees beside the chat. Send the WHOLE list every time — it replaces the previous one. Each step is an object with exactly the fields "step" (a short imperative sentence), "status" (${PLAN_STATUSES.join(' | ')}) and optionally "note". Exactly one step is in_progress while work remains; a step that cannot proceed is blocked (with a note); a dropped step is skipped (with a note). Mark steps completed the moment they are done — never before, and never because you meant to do them. Several steps may be completed in one call. Close the last step together with your final answer, not before it. If the plan changes or an unfinished step is dropped, say why in explanation. The user sees the list beside the chat, so do not repeat it in prose. Not for questions, lookups or single edits — only for work that takes more than a handful of tool calls.`,
        parameters: obj(
          {
            title: str(
              `3–6 words naming the task; required on the first call of a chat (max ${PLAN_LIMITS.titleChars} characters).`
            ),
            explanation: str(
              `Why the plan changed. Required when a step that was not completed/skipped disappears or is reworded, and when the list is emptied to withdraw the plan (max ${PLAN_LIMITS.explanationChars} characters).`
            ),
            steps: {
              type: 'array',
              maxItems: PLAN_LIMITS.steps,
              description: `The complete list, in order (max ${PLAN_LIMITS.steps} steps). An empty list withdraws the plan.`,
              items: obj(
                {
                  step: str(
                    `One short imperative sentence, 5–7 words (max ${PLAN_LIMITS.stepChars} characters).`
                  ),
                  status: { type: 'string', enum: [...PLAN_STATUSES], description: 'The step’s state.' },
                  note: str(
                    `Required on blocked (what blocks it) and skipped (why it is dropped); optional on completed (what came out). Max ${PLAN_LIMITS.noteChars} characters.`
                  )
                },
                ['step', 'status']
              )
            }
          },
          ['steps']
        )
      }
    },
    run: async (a, ctx) => {
      if (!ctx.plan) {
        return S({ error: 'plan is not available in this session — this client keeps its own task list.' })
      }
      const prev = ctx.plan.current()
      const v = validatePlanUpdate(prev, a)
      if (!v.ok) {
        // Refused: the model is told what was wrong AND what still stands, so "latest result" is
        // never a rejected list.
        return S({
          error: `plan not updated: ${v.error}`,
          ...(prev ? { current_plan: formatPlanForModel(prev) } : {})
        })
      }
      if (v.cleared) {
        await ctx.plan.update(null, v.input.explanation)
        return 'Plan withdrawn.'
      }
      const next = {
        title: v.input.title || prev?.title || 'Plan',
        steps: v.input.steps,
        revision: (prev?.revision ?? 0) + 1,
        updated: new Date().toISOString()
      }
      await ctx.plan.update(next, v.input.explanation)
      const { completed, total } = planProgress(next)
      const current = next.steps.find((s) => s.status === 'in_progress')
      const head =
        `Plan updated · ${completed}/${total}` +
        (current ? ` · in progress: ${current.step}` : ' · all steps closed')
      return `${head}\n${formatPlanForModel(next)}`
    }
  }
]
