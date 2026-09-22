import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'public/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Financial correctness rail: money must never touch IEEE-754 floats.
    // `src/core/money.ts` is the single module allowed to reason about number
    // parsing, and even there the result is validated to be a safe integer.
    files: ['src/core/money.ts', 'src/core/fees.ts', 'src/core/unique-amount.ts', 'src/services/wallet.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money math must stay in integers. Use parseToman() from src/core/money.ts.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'round',
          message: 'Never round money. Base amounts are integers by construction.',
        },
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money math must stay in integers. Use parseToman() from src/core/money.ts.',
        },
        {
          object: 'Number',
          property: 'EPSILON',
          message: 'Floating point comparison is forbidden for money.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
