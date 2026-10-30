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
      // Un parámetro con prefijo `_` es una «prueba» de tipos (p. ej. `assertInitiativeInOrganization(..., _proof)`), no un olvido.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
    // La semilla escribe con carga masiva y sin guardias de entidad: solo la usan sus comandos y las pruebas, nunca el código de la app.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/seed/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/seed/*', '**/seed/*'], message: 'El código de la semilla (carga masiva, datos de demostración) no se importa desde la aplicación.' },
            { group: ['@/mocks/*', '**/mocks/*'], message: 'Los datos de demostración no se importan desde la aplicación.' }
          ]
        }
      ]
    }
  },
  {
    files: ['tests/**/*.{ts,tsx}', 'scripts/**/*.mjs', 'prisma/**/*.ts'],
    rules: {
      'no-console': 'off',
      'react/jsx-no-literals': 'off'
    }
  }
]);
