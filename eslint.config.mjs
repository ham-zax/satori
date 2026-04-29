import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const nodeGlobals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
};

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'eslint.config.mjs',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: nodeGlobals,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      'no-useless-escape': 'off',
    },
  },
];
