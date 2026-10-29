/**
 * A word-level diff, for showing an author what moved in a chapter since they last read it.
 *
 * Words rather than characters: a chapter diff is read by a person deciding whether they still agree
 * with a sentence, and a character diff of prose is a mess of fragments. Written here rather than
 * pulled in: it is a textbook LCS over a few hundred tokens, and a dependency for that would be
 * shipped in every build for one panel.
 */
export interface DiffPart {
  kind: 'same' | 'added' | 'removed'
  text: string
}

/** Split into words *and* the whitespace between them, so rejoining reproduces the input exactly. */
const tokenize = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? []

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before)
  const b = tokenize(after)

  // Longest common subsequence lengths. Bounded work: chapters are prose, not log files, and the
  // caller only ever hands over one chapter at a time.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const parts: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string): void => {
    const last = parts[parts.length - 1]
    if (last && last.kind === kind) last.text += text
    else parts.push({ kind, text })
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('removed', a[i++])
    } else {
      push('added', b[j++])
    }
  }
  while (i < a.length) push('removed', a[i++])
  while (j < b.length) push('added', b[j++])
  return parts
}

/** Whether anything actually differs — cheaper to ask than to scan the parts at every call site. */
export const hasChanges = (parts: DiffPart[]): boolean => parts.some((p) => p.kind !== 'same')
