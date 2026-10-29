import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

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
  }
)
