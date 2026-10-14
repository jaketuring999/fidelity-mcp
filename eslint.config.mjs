import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'artifacts/**', 'docs/fidelity/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts', 'scripts/**/*.{ts,mjs}', 'tests/e2e/**/*.ts', '*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Provider JSON and simulated browser fixtures have dynamic external shapes.
    // Keep this exception at those boundaries, not throughout application code.
    files: ['src/bridge/fidelity-api.ts', 'tests/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
