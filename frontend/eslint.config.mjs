import coreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

/**
 * Flat config. eslint-config-next 16 ships native flat config arrays, so no FlatCompat shim —
 * running these through the eslintrc compat layer throws on a circular plugin reference.
 */
const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Unused function arguments are often meaningful in handler signatures; a leading
      // underscore marks them deliberate.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default config
