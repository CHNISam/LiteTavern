import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.tmp/**',
      '**/.wrangler/**',
      '.playwright-cli/**',
      'output/**'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: ['deploy/internal-gate/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        crypto: 'readonly',
        DataView: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        atob: 'readonly',
        btoa: 'readonly'
      }
    }
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        URL: 'readonly',
        fetch: 'readonly'
      }
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Blob: 'readonly',
        btoa: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        DataView: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        process: 'readonly',
        Request: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly'
      }
    }
  }
);
