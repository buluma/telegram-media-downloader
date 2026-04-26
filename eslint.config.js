// Flat-config (ESLint 9). Keeps rules pragmatic — the project predates a
// linter, so we'd rather fix real bugs than chase style.

import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.es2024 },
        },
        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-constant-condition': ['warn', { checkLoops: false }],
            'no-prototype-builtins': 'off',
            // sanitizeName matches ASCII control chars on purpose; the
            // \x00-\x1f range is the whole point of the regex.
            'no-control-regex': 'off',
            'no-self-assign': 'warn',
            'no-useless-escape': 'warn',
        },
    },
    {
        files: ['src/web/public/**/*.js'],
        languageOptions: {
            globals: { ...globals.browser },
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'docs/**',
            '*.min.js',
        ],
    },
];
