import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import boundaries from 'eslint-plugin-boundaries';
import react from '@eslint-react/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Packages the domain/application layers must never import (framework-free rule, docs/14 §14.2).
const FRAMEWORK_PACKAGES = [
  '@nestjs/*',
  '@prisma/client',
  'express',
  'next',
  'next/*',
  'pg-boss',
  '@aws-sdk/*',
  'argon2',
  'nodemailer',
  'sharp',
  'pdfjs-dist',
];

// Isomorphic contracts may only depend on zod. Every other runtime package is forbidden.
const CONTRACTS_FORBIDDEN_PACKAGES = [
  '@ant-design/*',
  '@aws-sdk/*',
  '@hookform/*',
  '@nestjs/*',
  '@prisma/client',
  '@tanstack/*',
  'antd',
  'argon2',
  'cookie-parser',
  'express',
  'file-type',
  'nestjs-pino',
  'next',
  'next/*',
  'next-intl',
  'nodemailer',
  'pdfjs-dist',
  'pg-boss',
  'pino',
  'pino-http',
  'react',
  'react-dom',
  'react-hook-form',
  'react-markdown',
  'reflect-metadata',
  'rehype-sanitize',
  'remark-gfm',
  'rxjs',
  'sharp',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.next/**',
      'coverage/**',
      'next-env.d.ts',
      'prisma/generated/**',
      // Scratch worktrees an agent checks the repository out into: a second copy of every source
      // file, outside every tsconfig, which typed linting cannot resolve and nobody wants linted
      // twice. Ignored by git for the same reason.
      '.claude/worktrees/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Type-aware linting for the TypeScript sources.
  {
    files: ['server/**/*.ts', 'src/**/*.{ts,tsx}', 'prisma/**/*.ts', 'test/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // Classic multi-project mode: the codebase has purpose-specific tsconfigs (client, server,
        // test) with different lib/jsx/module settings, which projectService cannot auto-discover
        // (it only finds the root tsconfig.json).
        project: ['./tsconfig.json', './tsconfig.server.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },

  // Domain and application layers are framework-free.
  {
    files: ['src/server/domain/**/*.ts', 'src/server/application/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message:
                'domain/application must stay framework-free (docs/14 §14.2); depend on ports instead.',
            },
          ],
        },
      ],
    },
  },

  // The whole server may use the injected logger, never console.
  {
    files: ['server/**/*.ts', 'src/server/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  // Isomorphic contracts: zod and relative files only, no runtime deps.
  {
    files: ['src/shared/contracts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: CONTRACTS_FORBIDDEN_PACKAGES,
              message: 'src/shared/contracts may only import zod and relative files.',
            },
          ],
        },
      ],
    },
  },

  // Feature-Sliced Design + client/server boundaries.
  {
    files: ['src/web/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/web/**/*', 'src/app/**/*', 'src/server/**/*', 'src/i18n/**/*'],
      'boundaries/elements': [
        { type: 'server', pattern: 'src/server/**/*', mode: 'full' },
        { type: 'contracts', pattern: 'src/shared/contracts/**/*', mode: 'full' },
        { type: 'i18n', pattern: 'src/i18n/**/*', mode: 'full' },
        { type: 'app', pattern: 'src/app/**/*', mode: 'full' },
        { type: 'screens', pattern: 'src/web/screens/**/*', mode: 'full' },
        { type: 'widgets', pattern: 'src/web/widgets/**/*', mode: 'full' },
        { type: 'features', pattern: 'src/web/features/**/*', mode: 'full' },
        { type: 'entities', pattern: 'src/web/entities/**/*', mode: 'full' },
        { type: 'shared', pattern: 'src/web/shared/**/*', mode: 'full' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message: '${file.type} is not allowed to import ${dependency.type} (docs/10 §10.1).',
          rules: [
            {
              from: ['app'],
              allow: ['screens', 'widgets', 'features', 'entities', 'shared', 'contracts', 'i18n'],
            },
            {
              from: ['screens'],
              allow: ['screens', 'widgets', 'features', 'entities', 'shared', 'contracts'],
            },
            {
              from: ['widgets'],
              allow: ['widgets', 'features', 'entities', 'shared', 'contracts'],
            },
            { from: ['features'], allow: ['features', 'entities', 'shared', 'contracts'] },
            { from: ['entities'], allow: ['entities', 'shared', 'contracts'] },
            { from: ['shared'], allow: ['shared', 'contracts'] },
          ],
        },
      ],
    },
  },

  // React rules for the client.
  {
    files: ['src/web/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    ...react.configs['recommended-type-checked'],
  },
  {
    files: ['src/web/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Test files may name mock factories after the hooks they replace (vi.mock('next/navigation')).
  {
    files: ['**/*.test.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    rules: {
      '@eslint-react/hooks-extra/no-unnecessary-use-prefix': 'off',
    },
  },

  // Node globals for backend, tooling and config files.
  {
    files: [
      'server/**/*.{ts,mjs}',
      'scripts/**/*.mjs',
      'src/server/**/*.ts',
      'prisma/**/*.ts',
      '*.{mjs,ts}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Config and tooling files: no type-aware linting, console allowed.
  {
    files: ['**/*.mjs', '**/*.config.{ts,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.mjs', '**/*.config.{ts,mjs}'],
    rules: {
      'no-console': 'off',
    },
  },

  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    rules: {
      // TypeScript itself resolves modules and checks members; these import-x rules only
      // produce false positives on CJS/ESM interop (e.g. ESLint plugin default imports).
      'import-x/no-unresolved': 'off',
      'import-x/namespace': 'off',
      'import-x/default': 'off',
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
    },
  },

  prettier,
);
