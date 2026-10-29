/**
 * What can be said about a formula before the server sees it.
 *
 * The server is the judge (asteval, in `engine/params.py`); this side exists so that a wrong formula is
 * refused where it is typed, with the text still in the field, instead of coming back as a message
 * about a value that was already sent. So it refuses only what the server would refuse too — an unknown
 * name, a bracket without its partner, two operators in a row — plus the two things the server accepts
 * and gets silently WRONG: `2^3` is 1 in Python (a bit-xor, not a power) and `0,5` is a pair, not a
 * half. Both come back as a number or as "did not produce a number", and neither says what happened.
 *
 * The grammar is the one the stored-formula interpreter (bw2parameters on asteval) evaluates: arithmetic,
 * the maths functions below, comparisons, and/or/not, and `value if condition else other` — the handbook's
 * "what you can put in a formula", nothing more.
 *
 * Also here: the pieces a completion popup needs — the word under the caret, the parameter names that
 * match it, and the text after one is picked.
 */

/** Names the server's interpreter knows besides the parameters — the maths that fits in a formula.
 *  A subset of asteval's table on purpose: `open`, `print` and `delete` are in that table too, and an
 *  LCA formula that names them is a typo. */
export const FORMULA_FUNCTIONS: readonly string[] = [
  'abs',
  'min',
  'max',
  'round',
  'sum',
  'mean',
  'median',
  'prod',
  'average',
  'std',
  'var',
  'sqrt',
  'square',
  'reciprocal',
  'pow',
  'power',
  'exp',
  'exp2',
  'expm1',
  'log',
  'log10',
  'log2',
  'log1p',
  'ln',
  'floor',
  'ceil',
  'trunc',
  'rint',
  'fix',
  'fabs',
  'sign',
  'hypot',
  'copysign',
  'fmod',
  'mod',
  'remainder',
  'divmod',
  'clip',
  'minimum',
  'maximum',
  'fmin',
  'fmax',
  'where',
  'interp',
  'percentile',
  'factorial',
  'degrees',
  'radians',
  'deg2rad',
  'rad2deg',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'arcsin',
  'arccos',
  'arctan',
  'arctan2',
  'arcsinh',
  'arccosh',
  'arctanh',
  'int',
  'float',
  'bool',
  'isnan',
  'isinf',
  'isfinite'
]
/** Values that stand on their own. */
export const FORMULA_CONSTANTS: readonly string[] = ['pi', 'e', 'inf', 'nan', 'True', 'False']

const FUNCTIONS = new Set(FORMULA_FUNCTIONS)
const CONSTANTS = new Set(FORMULA_CONSTANTS)

export interface ParamName {
  name: string
  /** What the completion shows beside the name — the current value and unit, when known. */
  hint?: string
}

export interface FormulaProblem {
  /** Which test failed — for a caller that treats one kind differently (an unknown name that is still
   *  being typed is not said yet). */
  kind: 'char' | 'decimal' | 'power' | 'parens' | 'syntax' | 'unknown' | 'call' | 'self'
  /** The sentence shown under the field. */
  message: string
  /** kind "unknown": the name, and the parameter it most likely meant. */
  name?: string
  suggestion?: string
}

type Tok = { t: 'num' | 'id' | 'kw' | 'op' | '(' | ')' | ','; v: string; i: number }

/** The words of a choose-between expression (`a if x < 1 else b`) and its logic — Python's, which is
 *  what the stored-formula interpreter evaluates. */
const KEYWORDS = new Set(['if', 'else', 'and', 'or', 'not'])
const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!='])

const NUM_RE = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*/
const IDENT_CHAR = /[A-Za-z0-9_]/

function tokenize(text: string): { toks: Tok[]; problem: FormulaProblem | null } {
  const toks: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const rest = text.slice(i)
    let m = NUM_RE.exec(rest)
    if (m) {
      toks.push({ t: 'num', v: m[0], i })
      i += m[0].length
      continue
    }
    m = ID_RE.exec(rest)
    if (m) {
      toks.push({ t: KEYWORDS.has(m[0]) ? 'kw' : 'id', v: m[0], i })
      i += m[0].length
      continue
    }
    const two = rest.slice(0, 2)
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      toks.push({ t: 'op', v: two, i })
      i += 2
      continue
    }
    if (c === '<' || c === '>') {
      toks.push({ t: 'op', v: c, i })
      i++
      continue
    }
    if (rest.startsWith('**')) {
      toks.push({ t: 'op', v: '**', i })
      i += 2
      continue
    }
    if (rest.startsWith('//')) {
      // Floor division — read as two divisions it was "/ /" and refused.
      toks.push({ t: 'op', v: '//', i })
      i += 2
      continue
    }
    if ('+-*/%'.includes(c)) {
      toks.push({ t: 'op', v: c, i })
      i++
      continue
    }
    if (c === '(' || c === ')' || c === ',') {
      toks.push({ t: c, v: c, i })
      i++
      continue
    }
    if (c === '^') {
      // Python reads ^ as bit-xor: 2^3 is 1, and the server hands that back as a perfectly good number.
      return { toks, problem: { kind: 'power', message: 'Write powers as **, not ^ (2**3, not 2^3).' } }
    }
    if (c === '=') {
      return {
        toks,
        problem: {
          kind: 'syntax',
          message: 'A formula is an expression — leave out the "=" (a comparison is "==").'
        }
      }
    }
    return { toks, problem: { kind: 'char', message: `"${c}" cannot be used in a formula.` } }
  }
  return { toks, problem: null }
}

/** Edit distance, small strings only — a formula's names are short. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/** The parameter a mistyped name most likely meant: the same letters in another case, or one that
 *  begins with it, or one a couple of keystrokes away. Nothing when nothing is close. */
export function closestName(name: string, names: readonly string[]): string | undefined {
  const lower = name.toLowerCase()
  const ci = names.find((n) => n.toLowerCase() === lower)
  if (ci) return ci
  if (lower.length >= 3) {
    // A name that continues what was typed comes first ("mass_g" → mass_glass, not mass); failing that,
    // the longest name the typed text continues ("mass_glassy" → mass_glass).
    const cont = names.filter((n) => n.toLowerCase().startsWith(lower))
    if (cont.length) return cont.sort((a, b) => a.length - b.length)[0]
    const stem = names.filter((n) => lower.startsWith(n.toLowerCase()))
    if (stem.length) return stem.sort((a, b) => b.length - a.length)[0]
  }
  const budget = Math.max(1, Math.floor(name.length / 3))
  let best: string | undefined
  let bestD = budget + 1
  for (const n of names) {
    const d = distance(lower, n.toLowerCase())
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return best
}

/**
 * The first thing wrong with a formula, or null when the server would take it.
 *
 * `params` null means the parameter list is not known (still loading, or the process lives in a database
 * without parameters): the structure is still checked, names are not — flagging every name as unknown
 * because a request has not answered yet would be worse than saying nothing.
 * `self` is the parameter whose own formula this is; naming itself is a cycle the server refuses.
 */
export function lintFormula(
  text: string,
  params: readonly ParamName[] | null,
  opts: { self?: string } = {}
): FormulaProblem | null {
  if (!text.trim()) return null
  const { toks, problem } = tokenize(text)
  if (problem) return problem

  let depth = 0
  for (const tk of toks) {
    if (tk.t === '(') depth++
    if (tk.t === ')') {
      depth--
      if (depth < 0) return { kind: 'parens', message: '")" without a matching "(".' }
    }
  }
  if (depth > 0) {
    return { kind: 'parens', message: depth === 1 ? 'A "(" is not closed.' : `${depth} "(" are not closed.` }
  }

  const names = params ? params.map((p) => p.name) : null
  const nameSet = names ? new Set(names) : null
  let pos = 0
  const peek = (): Tok | undefined => toks[pos]
  const fail = (p: FormulaProblem): FormulaProblem => p
  let err: FormulaProblem | null = null

  // Recursive descent over the arithmetic the server evaluates. Each level returns false once `err` is
  // set, so the first problem in reading order is the one reported.
  const primary = (): boolean => {
    const tk = peek()
    if (!tk) {
      const last = toks[toks.length - 1]
      err = fail({
        kind: 'syntax',
        message:
          last && (last.t === 'op' || last.t === 'kw')
            ? `The formula ends with "${last.v}".`
            : 'The formula is incomplete.'
      })
      return false
    }
    if (tk.t === 'num') {
      pos++
      return true
    }
    if (tk.t === '(') {
      pos++
      if (!expr()) return false
      const close = peek()
      if (!close || close.t !== ')') {
        err = fail({
          kind: 'syntax',
          message: `Expected ")" ${close ? `before "${close.v}"` : 'at the end'}.`
        })
        return false
      }
      pos++
      return true
    }
    if (tk.t === 'id') {
      pos++
      const next = peek()
      if (next && next.t === '(') {
        // A call. Parameters cannot be called, and only the known maths can.
        if (!FUNCTIONS.has(tk.v)) {
          err = fail(
            nameSet?.has(tk.v)
              ? { kind: 'call', message: `"${tk.v}" is a parameter, not a function — no brackets after it.` }
              : { kind: 'call', message: `Unknown function "${tk.v}".`, name: tk.v }
          )
          return false
        }
        pos++
        if (peek()?.t !== ')') {
          if (!expr()) return false
          while (peek()?.t === ',') {
            pos++
            if (!expr()) return false
          }
        }
        if (peek()?.t !== ')') {
          err = fail({ kind: 'syntax', message: `Expected ")" to close ${tk.v}(…).` })
          return false
        }
        pos++
        return true
      }
      if (opts.self && tk.v === opts.self) {
        err = fail({ kind: 'self', message: `"${tk.v}" cannot reference itself.` })
        return false
      }
      if (nameSet?.has(tk.v) || CONSTANTS.has(tk.v)) return true
      if (FUNCTIONS.has(tk.v)) {
        err = fail({ kind: 'call', message: `"${tk.v}" needs brackets: ${tk.v}(…).` })
        return false
      }
      if (!names) return true // list unknown: not this side's call
      const suggestion = closestName(tk.v, names)
      err = fail({
        kind: 'unknown',
        message: suggestion
          ? `Unknown name "${tk.v}" — did you mean "${suggestion}"?`
          : `Unknown name "${tk.v}".`,
        name: tk.v,
        suggestion
      })
      return false
    }
    if (tk.t === ',') {
      err = fail({ kind: 'decimal', message: 'Use a point as the decimal separator (0.5, not 0,5).' })
      return false
    }
    err = fail({ kind: 'syntax', message: `Unexpected "${tk.v}".` })
    return false
  }
  const unary = (): boolean => {
    const tk = peek()
    if (tk && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
      pos++
      return unary()
    }
    return primary()
  }
  const factor = (): boolean => {
    if (!unary()) return false
    const tk = peek()
    if (tk && tk.t === 'op' && tk.v === '**') {
      pos++
      return factor() // right-associative, as in Python
    }
    return true
  }
  const term = (): boolean => {
    if (!factor()) return false
    for (;;) {
      const tk = peek()
      if (tk && tk.t === 'op' && (tk.v === '*' || tk.v === '/' || tk.v === '//' || tk.v === '%')) {
        pos++
        if (!factor()) return false
      } else return true
    }
  }
  const arith = (): boolean => {
    if (!term()) return false
    for (;;) {
      const tk = peek()
      if (tk && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
        pos++
        if (!term()) return false
      } else return true
    }
  }
  const comparison = (): boolean => {
    if (!arith()) return false
    for (;;) {
      const tk = peek()
      if (tk && tk.t === 'op' && COMPARISONS.has(tk.v)) {
        pos++
        if (!arith()) return false
      } else return true
    }
  }
  const notExpr = (): boolean => {
    const tk = peek()
    if (tk && tk.t === 'kw' && tk.v === 'not') {
      pos++
      return notExpr()
    }
    return comparison()
  }
  const andExpr = (): boolean => {
    if (!notExpr()) return false
    while (peek()?.t === 'kw' && peek()?.v === 'and') {
      pos++
      if (!notExpr()) return false
    }
    return true
  }
  const orExpr = (): boolean => {
    if (!andExpr()) return false
    while (peek()?.t === 'kw' && peek()?.v === 'or') {
      pos++
      if (!andExpr()) return false
    }
    return true
  }
  // `value if condition else other` — the one conditional a formula has (no if-blocks).
  const expr = (): boolean => {
    if (!orExpr()) return false
    const tk = peek()
    if (tk && tk.t === 'kw' && tk.v === 'if') {
      pos++
      if (!orExpr()) return false
      const el = peek()
      if (!el || el.t !== 'kw' || el.v !== 'else') {
        err = fail({ kind: 'syntax', message: 'An "if" needs an "else": value if condition else other.' })
        return false
      }
      pos++
      return expr()
    }
    return true
  }

  if (!expr()) return err
  const left = peek()
  if (left) {
    // Something follows a complete expression at the top level.
    if (left.t === ',')
      return { kind: 'decimal', message: 'Use a point as the decimal separator (0.5, not 0,5).' }
    if (left.t === 'num' || left.t === 'id' || left.t === '(') {
      return { kind: 'syntax', message: `Missing operator before "${left.v}".` }
    }
    return { kind: 'syntax', message: `Unexpected "${left.v}".` }
  }
  return null
}

/** The identifier around the caret: where it starts and ends, the whole of it, and the part typed so
 *  far (start → caret), which is what the completion matches. Empty when the caret is not in a name —
 *  a number is not a name either. */
export function wordAt(
  text: string,
  caret: number
): { start: number; end: number; word: string; prefix: string } {
  const at = Math.max(0, Math.min(caret, text.length))
  let start = at
  while (start > 0 && IDENT_CHAR.test(text[start - 1])) start--
  let end = at
  while (end < text.length && IDENT_CHAR.test(text[end])) end++
  const word = text.slice(start, end)
  if (!word || /^[0-9]/.test(word)) return { start: at, end: at, word: '', prefix: '' }
  return { start, end, word, prefix: text.slice(start, at) }
}

/** Parameter names for a typed prefix: the name typed in full first, then the ones that begin with it,
 *  then the ones that contain it. The full name stays in the list — it is the confirmation that "test"
 *  IS a parameter; it was dropped once typed out, so the list vanished exactly when the name was right
 *  and looked the same as a typo. One letter past it ("testb") and it is gone. */
export function suggest(prefix: string, params: readonly ParamName[], limit = 8): ParamName[] {
  const q = prefix.toLowerCase()
  if (!q) return []
  const exact: ParamName[] = []
  const starts: ParamName[] = []
  const contains: ParamName[] = []
  for (const p of params) {
    const n = p.name.toLowerCase()
    if (p.name === prefix) exact.push(p)
    else if (n.startsWith(q)) starts.push(p)
    else if (n.includes(q)) contains.push(p)
  }
  const byName = (a: ParamName, b: ParamName): number => a.name.localeCompare(b.name)
  return [...exact, ...starts.sort(byName), ...contains.sort(byName)].slice(0, limit)
}

/** The text after a name is picked for the word at `start…end`, and where the caret goes. */
export function insertName(
  text: string,
  start: number,
  end: number,
  name: string
): { text: string; caret: number } {
  return { text: text.slice(0, start) + name + text.slice(end), caret: start + name.length }
}

/** Every whole-word use of `name` replaced — what the "did you mean" button does. */
export function replaceName(text: string, name: string, replacement: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\b${esc}\\b`, 'g'), replacement)
}
