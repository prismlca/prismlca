/** UI-surface tools: the canvas, results setup, asking the user. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { bool, obj, str, strArr } from '../schema'
import { S } from '../format'
import { delegate } from '../impl'

export const canvasTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'set_chat_title',
        description:
          'Name THIS conversation with a short, punchy title (3–6 words). Call this once at the very start of a new chat. The title is used only as the chat label — do not mention it in your reply to the user.',
        parameters: obj({ title: str('Short, punchy chat title.') }, ['title'])
      }
    },
    surface: 'ui',
    run: async (a, ctx) => S(await ctx.ui('set_chat_title', a))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Ask the user to clarify something, with 2–5 predefined answer options per question, shown as clickable buttons in the chat; the run pauses until they answer. The card always offers a field for the user\'s own words as well, so never add an "Other" or "Something else" option yourself — spend the slots on real choices. An answer marked free_text was typed by the user rather than picked: act on what it says (it may name a choice you did not offer); free_text on the whole result means one typed reply answers the whole form. Use it for decisions that materially affect the work (functional unit, system boundaries, geography, method choice, which of several search matches to use, confirming destructive actions) — never when the answer is obvious, already given, or genuinely open-ended. ASK EVERYTHING YOU ALREADY KNOW YOU NEED IN ONE CALL: pass "questions" (up to 4) and they are shown as a single form. Every extra call stops the run and waits for a human who may be away for hours — this is the one place where a wasted round costs someone their attention, not just tokens.',
        parameters: obj(
          {
            question: str('The question — one short sentence.'),
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              description: '2–5 answer options.',
              items: obj(
                {
                  label: str('Short option label (a few words).'),
                  description: str('Optional one-line explanation of the option.')
                },
                ['label']
              )
            },
            multi_select: {
              type: 'boolean',
              description:
                'Default false, which is what nearly every question wants: the options are alternatives and exactly ONE is chosen. Set true only when the options genuinely combine and picking several at once is meaningful (e.g. "which life-cycle stages should be included?"). If choosing two of them would contradict each other, leave it false.'
            },
            questions: {
              type: 'array',
              maxItems: 4,
              description:
                'Up to 4 questions asked TOGETHER as one form. Use this whenever you already know you need more than one answer before you can start — each extra call is another wait on a human. FOUR SLOTS, SO SPEND THEM ON WHAT CANNOT BE CHANGED LATER: what the study is measured PER (the functional unit) and where the numbers will COME FROM outrank any question about scope, because a scope decision can be revisited on a finished model and these two cannot. Measured 2026-08-13: a wall-paint study spent all its questions on scope details, silently made itself "one bucket" instead of a painted area, and estimated a recipe it could have researched.',
              items: obj(
                {
                  question: str('The question — one short sentence.'),
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 5,
                    description: '2–5 answer options.',
                    items: obj(
                      {
                        label: str('Short option label (a few words).'),
                        description: str('Optional one-line explanation.')
                      },
                      ['label']
                    )
                  },
                  multi_select: { type: 'boolean', description: 'See above; exactly one is the normal case.' }
                },
                ['question', 'options']
              )
            }
          },
          []
        )
      }
    },
    surface: 'ui',
    run: async (a, ctx) => {
      // One shape downstream: the renderer always receives a list, and always answers with one array
      // of labels per question.
      const asked: any[] =
        Array.isArray(a.questions) && a.questions.length
          ? a.questions
          : [{ question: a.question, options: a.options, multi_select: a.multi_select }]
      if (!asked[0]?.question) return S({ error: 'Pass "question" + "options", or "questions".' })

      const r = await ctx.ui('ask_user', { questions: asked })
      const raw = Array.isArray(r?.answers) ? r.answers : []
      // Tolerate the old flat shape (one question answered with a list of labels).
      const perQuestion: string[][] = Array.isArray(raw[0])
        ? raw.map((x: unknown[]) => x.map(String))
        : [raw.map(String)]
      // Which answers the user typed rather than picked: one flag per question from the cards' own
      // fields, or a single `true` when one sentence typed into the chat input answered the whole form.
      const ownWords: boolean[] = Array.isArray(r?.freeText) ? r.freeText.map(Boolean) : []
      const freeText = r?.freeText === true ? true : undefined
      const pairs = asked.map((q, i) => ({
        question: String(q.question),
        answer: perQuestion[i] ?? [],
        ...(ownWords[i] ? { free_text: true } : {})
      }))
      const transcript = pairs
        .map((p) => `> ❓ ${p.question}\n> ➤ ${p.answer.join(', ') || '(no answer)'}`)
        .join('\n>\n')
      return {
        result: S(
          pairs.length === 1
            ? { ...pairs[0], ...(freeText ? { free_text: true } : {}) }
            : { answers: pairs, free_text: freeText }
        ),
        transcript: `\n\n${transcript}\n\n`
      }
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_canvas',
        description:
          'What is actually drawn on the canvas right now: foreground activities AND the read-only background reference boxes (which the model graph does not list). Use this — not just get_model_graph — to know if the canvas is truly empty before saying so.',
        parameters: obj({})
      }
    },
    surface: 'ui',
    run: async (_a, ctx) => S(await ctx.ui('get_canvas', {}))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'screenshot_canvas',
        description:
          'Capture what the canvas currently shows, to visually inspect the model. Only useful on vision-capable models.',
        parameters: obj({})
      }
    },
    surface: 'ui',
    run: async (_a, ctx) => {
      const r = await ctx.ui('screenshot_canvas', {})
      if (r?.image) return { image: r.image as string }
      return S({ error: 'Screenshot not available.' })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'calculate_in_canvas',
        description:
          'Trigger the canvas "Calculate" for a process in the active model with a chosen method — shows the result banner + Sankey overlay to the user. Pass the process code (or omit it to use the user\'s current selection). FIRE-AND-FORGET: it returns as soon as the calculation is started, carries no score, and is not confirmation that anything was drawn — so never report to the user what the canvas now shows on the strength of this call. Use `calculate` for the number.',
        parameters: obj(
          {
            method: strArr('Method tuple from list_methods.'),
            code: str('Process code in the active model (optional — defaults to the selected process).')
          },
          ['method']
        )
      }
    },
    surface: 'ui',
    run: async (a, ctx) => S(await ctx.ui('calculate_in_canvas', a))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'setup_results',
        description:
          'Configure the Results page for the user — subjects (processes, each once per scenario for grouped bars), indicators ("methods"), stacked bars and split-by — on tab="overview" (comparison charts) or "detailed" (contribution tree). Without run=true it only prepares: the page is not switched to (canvas_view action="open_page" page="results" does that) and nothing is calculated until the user presses Calculate. With run=true the page opens and the calculation starts. Returns what the view actually holds — compare that with what you asked for.',
        parameters: obj(
          {
            tab: str('"overview" or "detailed".'),
            subjects: {
              type: 'array',
              description:
                'Subjects {database, code, scenario?}. Give the SAME process once per scenario to compare them side by side (scenario ids from list_scenarios); omit "scenario" for the baseline.',
              items: obj(
                {
                  database: str('db'),
                  code: str('code'),
                  scenario: str('Scenario id — omit for the baseline.')
                },
                ['database', 'code']
              )
            },
            methods: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
              description: 'Method tuples.'
            },
            stacked: { type: 'boolean', description: 'Overview: stacked bars on/off.' },
            split_by: str('Overview stacked split: "isic" | "cpc" | "tag:<group>".'),
            run: bool(
              'true = also start the calculation and switch the user to the Results page, as if they had pressed Calculate. FIRE-AND-FORGET: the answer carries no scores — use `calculate` or `compare` for numbers.'
            )
          },
          ['tab']
        )
      }
    },
    surface: 'ui',
    run: async (a, ctx) => S(await ctx.ui('setup_results', a))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'canvas_view',
        description:
          'Change what the app shows, without touching the model. action="jump" centres and selects a process (code); "layout" re-arranges all nodes; "clear" removes the read-only background reference boxes from the VIEW (nothing is deleted); "remove" removes one of them (code); "show" brings the PrismLCA window to the front — do this before a question or a confirmation the user must answer there; "open_model" opens another model (database) and makes it the active one; "open_page" opens a page (page): overview, model, parameters, scenarios, lcia, results or report.',
        parameters: obj(
          {
            action: str('One of: jump | layout | clear | remove | show | open_model | open_page.'),
            code: str('Process/reference code (action=jump/remove).'),
            database: str('Model to open (action=open_model).'),
            page: str(
              'Page to open (action=open_page): overview | model | parameters | scenarios | lcia | results | report.'
            )
          },
          ['action']
        )
      }
    },
    surface: 'ui',
    run: async (a, ctx) =>
      delegate(
        {
          jump: 'jump_to_process',
          layout: 'auto_layout',
          clear: 'clear_canvas',
          remove: 'remove_from_canvas',
          show: 'focus_window',
          open_model: 'switch_model',
          open_page: 'switch_page'
        },
        a,
        ctx,
        {
          jump: ['code'],
          remove: ['code'],
          open_model: ['database'],
          open_page: ['page']
        }
      )
  }
]
