import { builtinModules } from 'node:module'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Process boundaries. The renderer is a browser window: Node and Electron do not exist there, and its
 * tsconfig still knows Node's types because the renderer's tests read files, so a stray import passes the
 * typecheck and fails only when the window runs it. `src/shared` is compiled into both processes. And an
 * import across the renderer–main line already fails the typecheck, but with TS6307 ("not listed within
 * the file list … use an 'include' pattern"), whose suggested fix is the wrong one. These rules fail first,
 * and their messages name the way that works. Tests are left out: they run in Node.
 */
const NODE = builtinModules.filter((name) => !name.startsWith('_'))
const RENDERER_WAY =
  'The renderer runs in a browser window without Node or Electron. It reaches the main process only through ' +
  'window.prism, which src/preload/index.ts exposes — add a method there and its handler in src/main if ' +
  'one is missing. Pure code both sides need goes into src/shared. Do not widen a tsconfig "include".'
const SHARED_WAY =
  'src/shared runs in both processes, the Electron main process and the browser window, so it imports ' +
  'neither Node nor Electron nor code of one side. Keep the shared part pure here; what needs Node or ' +
  'Electron goes into src/main, and the renderer reaches it through window.prism.'
const MAIN_WAY =
  'src/main and src/preload do not include renderer code: the renderer is a separate bundle for the ' +
  'browser window. Move what both sides need into src/shared and import it from there. Do not widen a ' +
  'tsconfig "include".'

/** The import sources one side may not use: Node and Electron (when `runtime`), and the sibling folders. */
function forbidden({ runtime, siblings }) {
  const sibling = `^(\\.\\./)+(${siblings.join('|')})(/|$)`
  return runtime ? [`^(node:|electron(/|$)|(${NODE.join('|')})(/|$))`, sibling] : [sibling]
}

/** The rules for one side. `no-restricted-imports` sees static imports and re-exports only, so a dynamic
 *  `import()` of the same source is held by `no-restricted-syntax`. */
function boundary(message, sides) {
  const sources = forbidden(sides)
  return {
    'no-restricted-imports': ['error', { patterns: sources.map((regex) => ({ regex, message })) }],
    'no-restricted-syntax': [
      'error',
      ...sources.map((re) => ({
        selector: `ImportExpression[source.value=/${re.replace(/\//g, '\\/')}/]`,
        message
      }))
    ]
  }
}
const TESTS = ['**/*.test.{ts,tsx}', '**/test/**']

/** Lint gate for the Electron frontend. Focus: the error classes that have actually bitten us —
 * stale closures / wrong hook dependencies (react-hooks) and dead or unsafe TypeScript
 * (typescript-eslint). Style/formatting is intentionally out of scope. */
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '*.config.*'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The D3/ECharts integration code works with `any` deliberately (untyped chart instances,
      // d3 hierarchy nodes) — banning it would bury real findings under noise.
      '@typescript-eslint/no-explicit-any': 'off',
      // `catch {}` fallbacks around localStorage etc. are a deliberate pattern here.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
      ],
      // React-Compiler preview rules (new in react-hooks v7). They flag patterns this codebase
      // uses deliberately and correctly today: ref mirrors of state (nodesRef/edgesRef for
      // buildGraph), setState inside sync-effects, and imperative React Flow updates. Revisit
      // when adopting the React Compiler.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: TESTS,
    rules: boundary(RENDERER_WAY, { runtime: true, siblings: ['main', 'preload'] })
  },
  {
    files: ['src/shared/**/*.ts'],
    ignores: TESTS,
    rules: boundary(SHARED_WAY, { runtime: true, siblings: ['main', 'preload', 'renderer'] })
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    ignores: TESTS,
    rules: boundary(MAIN_WAY, { runtime: false, siblings: ['renderer'] })
  }
)
