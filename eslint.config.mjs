import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'next-env.d.ts',
    'src/generated/**',
    'prototype/**',
    '.agents/**',
    '.claude/**'
  ]),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }]
    }
  },
  {
    // Ningún texto visible vive en el código: todo sale de messages/{es,ca,en}.json (Regla 03 §7).
    files: ['src/**/*.tsx'],
    rules: {
      'react/jsx-no-literals': ['error', { noStrings: false, ignoreProps: true }]
    }
  },
  {
    // Galería interna de desarrollo (no es producción): sus textos de muestra no se traducen.
    files: ['src/components/dev/**/*.tsx'],
    rules: { 'react/jsx-no-literals': 'off' }
  },
  {
    files: ['tests/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'react/jsx-no-literals': 'off'
    }
  }
]);
