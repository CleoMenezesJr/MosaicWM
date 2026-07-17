import globals from 'globals';
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.gnomeShell,
        imports: true,
        log: 'readonly',
        global: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      // Style — matching existing codebase patterns
      'indent': ['error', 4, { SwitchCase: 1 }],
      'no-tabs': 'error',
      'no-trailing-spaces': 'error',
      'quotes': ['error', 'single', { avoidEscape: true }],
      'semi': ['error', 'always'],
      'comma-dangle': ['error', 'only-multiline'],

      // Allow unused vars with _ prefix (common in GNOME callbacks)
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // GNOME Shell extensions commonly use these patterns
      'no-constant-condition': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',

      // Consistency
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-throw-literal': 'error',

      // Complexity
      'complexity': ['error', 10],
    },
  },
  {
    ignores: ['build/**', 'scripts/**', 'docs/**', 'node_modules/**'],
  },
];
