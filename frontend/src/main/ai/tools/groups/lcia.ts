/** Method browsing and custom LCIA method management. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { bool, num, obj, str, strArr } from '../schema'
import { S, cap } from '../format'
import { delegate } from '../impl'

export const lciaTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_methods',
        description:
          'Find LCIA methods. Filter with a query — matching is forgiving, so "EF 3.1 climate change", "EF v3.1 climate", "ef3.1 gwp" all find the same method. With no query (or families=true) you get the CATALOGUE: every method family with its indicator count, so you can pick a family and then query inside it instead of guessing names. Use the returned method array as the "method" argument to calculate. Prefer entries with recommended:true — recommended:false marks specialist variants (biogenic-only, "no LT", GWP20/500, SLCF) that are easy to pick by mistake and give misleading totals.',
        parameters: obj({
          query: str('Optional filter text; punctuation, case and a "v" before a version are ignored.'),
          queries: {
            type: 'array',
            description:
              'Several filter texts in ONE call — use this whenever a study needs more than one indicator (climate + eutrophication + acidification was three calls).',
            items: { type: 'string' }
          },
          families: bool('true = return only the list of families with their indicator counts.'),
          recommended_only: bool(
            'true = leave out the specialist variants (biogenic-only, "no LT", GWP20/500, SLCF) and ' +
              'return only the ones this advice points at. A family answers with dozens of tuples ' +
              'otherwise, and a study normally wants one of them.'
          )
        })
      }
    },
    run: async (a, ctx) => {
      const all: any[] = (await ctx.api('GET', '/api/v1/calc/methods')) ?? []
      const list = Array.isArray(all) ? all : []
      // Family catalogue: one call that shows what exists. Without it, finding an indicator among 600+
      // is blind guessing at names — measured at 37 calls for a single method in a real session.
      const many: string[] = Array.isArray(a.queries)
        ? a.queries.map((q: unknown) => String(q)).filter(Boolean)
        : []
      // Same trap as search_background: a JSON-encoded array in the string slot would silently fall
      // through to the family catalogue — an ANSWER, so the model would never learn its batch was
      // dropped. Refuse it by name instead.
      if (typeof a.queries === 'string' && a.queries.trim() && !a.query)
        return S({
          error:
            '"queries" arrived as ONE string, not an array — the array was JSON-encoded into a ' +
            'string. Resend queries as a real JSON array value, e.g. ' +
            '{"queries": ["EF v3.1 climate change", "EF v3.1 water use"]} — do not wrap the array ' +
            'in quotes.'
        })
      if (a.families || (!a.query && !many.length)) {
        const fams = new Map<string, number>()
        for (const m of list) {
          const fam = String(m?.method?.[0] ?? m?.family ?? '')
          if (fam) fams.set(fam, (fams.get(fam) ?? 0) + 1)
        }
        return S({
          families: [...fams.entries()]
            .map(([family, indicators]) => ({ family, indicators }))
            .sort((x, y) => x.family.localeCompare(y.family)),
          total_indicators: list.length,
          hint: 'Query inside a family, e.g. query="EF v3.1 climate change".'
        })
      }
      // Forgiving match: drop punctuation, fold "v3.1"/"3.1", and require every query word to appear
      // somewhere in the family/category/indicator triple. Vendors write these names inconsistently
      // and the exact spelling is not something anyone should have to guess.
      const fold = (s: string): string =>
        s
          .toLowerCase()
          .replace(/\bv(\d)/g, '$1')
          .replace(/[^a-z0-9.]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      // Compared twice: once as written, once with spaces and dots squashed out, so "EF3.1" finds
      // "EF v3.1" and "GWP 100" finds "GWP100". Every query word still has to appear somewhere, which
      // is what keeps the squashed comparison from matching everything.
      const squash = (s: string): string => s.replace(/[\s.]/g, '')
      const hit = (hay: string, w: string): boolean => hay.includes(w) || squash(hay).includes(squash(w))
      const withHay = list.map((m) => ({ m, hay: fold([...(m?.method ?? []), m?.unit ?? ''].join(' ')) }))
      const byRecommended = (x: any, y: any): number => Number(!!y?.recommended) - Number(!!x?.recommended)
      // A query word that stands as a WHOLE word in the triple names it; one that only hides inside
      // another word ("h" in "change") does not. "ReCiPe 2016 midpoint H climate" matched (E) and (H)
      // alike and listed (E) first; "IPCC GWP100" put 2013 before 2021 (V386). So: whole-word hits
      // first, then recommended, then — when the query names no year — the newer family.
      const wholeWords = (hay: string, words: string[]): number =>
        words.filter((w) => new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(hay))
          .length
      const familyYear = (m: any): number => {
        const years = String(m?.method?.[0] ?? '').match(/\b(19|20)\d{2}\b/g)
        return years ? Math.max(...years.map(Number)) : 0
      }
      const rank = (words: string[]) => {
        const queryHasYear = words.some((w) => /^(19|20)\d{2}$/.test(w))
        return (x: { m: any; hay: string }, y: { m: any; hay: string }): number =>
          wholeWords(y.hay, words) - wholeWords(x.hay, words) ||
          byRecommended(x.m, y.m) ||
          (queryHasYear ? 0 : familyYear(y.m) - familyYear(x.m))
      }

      // One query's worth of work, so a batch is this same search run N times rather than a second
      // code path free to drift from it.
      const searchOne = (raw: string): Record<string, unknown> => {
        const words = fold(raw).split(' ').filter(Boolean)
        const matched = withHay
          .filter(({ hay }) => words.every((w) => hit(hay, w)))
          .sort(rank(words))
          .map(({ m }) => m)
        // recommended_only hides the specialist variants the description already warns about — but it
        // must never turn a family that HAS matches into "nothing found", or it becomes a trap of its
        // own. If no match is marked recommended, answer with all of them and say why.
        const wanted = a.recommended_only ? matched.filter((m: any) => m?.recommended) : matched
        const scored = wanted.length ? wanted : matched
        if (scored.length) {
          // `matched` is already ranked (whole-word hits, recommended, newer family); the filter kept its order.
          const { items, note } = cap(scored, 60)
          return {
            methods: items,
            note,
            recommended_only_note:
              a.recommended_only && !wanted.length
                ? 'None of these is marked recommended, so all matches are shown.'
                : undefined
          }
        }
        // Every word had to appear, so ONE wrong word returns nothing at all — and an empty list looks
        // exactly like "this family does not exist". On the Kimi run
        // "CML 2001 2016 baseline climate change GWP100" cost a whole round because CML v4.8 contains
        // neither "2001" nor "baseline". Fall back to the best partial match and, more usefully, name
        // the words that matched nothing: that is the difference between "search again" and "search
        // again for THIS".
        // `recommended_only` applies here too. It used to be honoured only when every word matched,
        // so the moment a query missed — which is exactly when the caller is least sure what it is
        // looking at — the answer filled up with the variants the parameter promises to leave out.
        // Measured: "EF 3.1 resource use fossils" ("fossils" appears in no indicator name)
        // came back with 12 entries under `recommended_only: true`, 7 of them `recommended: false`,
        // including all five "no LT" variants. Same safety valve as above: never turn a family that
        // HAS matches into "nothing found".
        const partial = withHay
          .map(({ m, hay }) => ({ m, n: words.filter((w) => hit(hay, w)).length }))
          .filter((x) => x.n > 0)
        const wantedPartial = a.recommended_only ? partial.filter((x) => (x.m as any)?.recommended) : partial
        const best = (wantedPartial.length ? wantedPartial : partial).sort(
          (x, y) => y.n - x.n || byRecommended(x.m, y.m)
        )
        const top = best.length ? best[0].n : 0
        const unmatched = words.filter((w) => !withHay.some(({ hay }) => hit(hay, w)))
        const { items, note } = cap(
          best.filter((x) => x.n === top).map((x) => x.m),
          60
        )
        return {
          methods: items,
          note,
          exact_match: false,
          matched_words: `${top} of ${words.length}`,
          unmatched_words: unmatched.length ? unmatched : undefined,
          hint: items.length
            ? `No entry contains every word of the query${unmatched.length ? ` — ${unmatched.map((w) => `"${w}"`).join(', ')} appear${unmatched.length === 1 ? 's' : ''} in no indicator name` : ''}. These are the closest matches; drop the words that did not match, or call list_methods with families=true to see what exists.`
            : 'No match at all. Call list_methods with families=true to see what exists.'
        }
      }

      // A single query keeps its old shape; a batch reports per query so answers stay paired with
      // the questions that asked them.
      if (!many.length) return S(searchOne(String(a.query)))
      return S({ results: many.map((q) => ({ query: q, ...searchOne(q) })) })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_characterization_factors',
        description:
          'Inspect/compare the characterization factors of up to 4 LCIA indicators: returns each characterised flow with its factor per method (null where a method doesn\'t cover it). Give method tuples from list_methods. Use flow_query to narrow to a flow (e.g. "methane") — the flow set is otherwise very large.',
        parameters: obj(
          {
            methods: {
              type: 'array',
              description: 'Up to 4 LCIA method tuples (each an array of strings, from list_methods).',
              items: { type: 'array', items: { type: 'string' } }
            },
            flow_query: str('Optional substring to filter flows by name/compartment (recommended).'),
            flow_queries: {
              type: 'array',
              description:
                'Several flows in ONE call, each checked against all the given methods. Verifying a use phase means four or five flows — that was four or five calls.',
              items: { type: 'string' }
            }
          },
          ['methods']
        )
      }
    },
    // Filtering + capping happen in the backend (same narrowing for the LCIA page, this tool and any
    // future MCP wrapper), so this stays a thin pass-through — see ADR-003/011.
    run: async (a, ctx) => {
      const post = async (flowQuery: string | null): Promise<any> =>
        ctx.api('POST', '/api/v1/calc/characterization-factors', {
          methods: a.methods,
          flow_query: flowQuery,
          limit: 40
        })
      // The methods axis batched from the start, the flow axis did not — the same asymmetry V6
      // removed from edit_tags (processes batched, values not).
      const many: string[] = Array.isArray(a.flow_queries)
        ? a.flow_queries.map((q: unknown) => String(q)).filter(Boolean)
        : []
      if (!many.length) return S(await post(a.flow_query || null))
      return S({ results: await Promise.all(many.map(async (q) => ({ flow_query: q, ...(await post(q)) }))) })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_method_families',
        description:
          'List all LCIA method families and their indicators; "editable"=true marks YOUR custom methods (imported methods are read-only), "custom"=true marks your own families. Read this before editing/duplicating a method.',
        parameters: obj({})
      }
    },
    run: async (_a, ctx) => S(await ctx.api('GET', '/api/v1/lcia/families'))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_method_factors',
        description:
          "Read one LCIA method's flows and characterization factors (and whether it is editable). Pass the method tuple.",
        parameters: obj({ method: strArr('Method tuple (from list_methods / list_method_families).') }, [
          'method'
        ])
      }
    },
    run: async (a, ctx) => S(await ctx.api('POST', '/api/v1/lcia/method-flows', { method: a.method }))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'search_biosphere_flows',
        description:
          'LCIA-METHOD use: find a biosphere (elementary) flow to characterise in one of YOUR custom LCIA methods. Relevance-ranked; returns each flow\'s "ref" (an id as a string — pass it back unchanged) for edit_lcia_method action="set_factor". To attach a flow as an emission on a process instead, use search_elementary_flows.',
        parameters: obj(
          { query: str('Search text, e.g. "methane air".'), limit: num('Max results (default 30).') },
          ['query']
        )
      }
    },
    run: async (a, ctx) =>
      S(
        await ctx.api(
          'GET',
          `/api/v1/lcia/flow-search?query=${encodeURIComponent(a.query)}&limit=${a.limit || 30}`
        )
      )
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_lcia_method',
        description:
          'Create or change one of YOUR custom LCIA methods (imported methods are read-only). action="duplicate" copies an existing method (src, family, name); "create" makes an empty one (family, name, optional unit); "rename" takes method + name; "set_factor" sets a flow\'s factor (method, ref, cf — get ref from search_biosphere_flows); "remove_flow" drops a flow (method, ref); "delete" removes the method. Not undoable.',
        parameters: obj(
          {
            action: str('One of: create | duplicate | rename | set_factor | remove_flow | delete.'),
            method: strArr('The custom method tuple (all actions except create/duplicate).'),
            src: strArr('Source method tuple to copy (action=duplicate).'),
            family: str('Target family — one of your own (action=create/duplicate).'),
            name: str('Indicator name (action=create/duplicate/rename).'),
            unit: str('Optional unit, e.g. "kg CO2-eq" (action=create).'),
            description: str('Optional family description (action=create/duplicate).'),
            ref: str(
              'Flow ref from search_biosphere_flows or get_method_factors (action=set_factor/remove_flow) — a string of digits, passed back EXACTLY as given (it is a 64-bit id; as a number it would be rounded).'
            ),
            cf: num('Characterization factor (action=set_factor).')
          },
          ['action']
        )
      }
    },
    run: async (a, ctx) =>
      delegate(
        {
          create: 'create_lcia_method',
          duplicate: 'duplicate_lcia_method',
          rename: 'rename_lcia_method',
          set_factor: 'set_method_factor',
          remove_flow: 'remove_method_flow',
          delete: 'delete_lcia_method'
        },
        a,
        ctx
      )
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'manage_method_family',
        description:
          'Create, describe, rename or delete one of YOUR LCIA method families (imported families are protected). `family` always names the family you act on: action="upsert" creates it or sets its description; "rename" additionally takes the new name in `name` and moves the family\'s methods; "delete" removes the family and its methods after asking the user. Not undoable.',
        parameters: obj(
          {
            action: str('One of: upsert | rename | delete.'),
            family: str('The family to act on (all actions); for rename this is its CURRENT name.'),
            name: str('New family name (action=rename only).'),
            description: str('Short description (action=upsert/rename).')
          },
          ['action', 'family']
        )
      }
    },
    run: async (a, ctx) =>
      delegate(
        { upsert: 'set_method_family', rename: 'edit_method_family', delete: 'delete_method_family' },
        a,
        ctx,
        {
          rename: ['name']
        }
      )
  }
]
