import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import { createApplicationEslintConfig } from '@joshuan/tooling/eslint';

const webFiles = ['src/web/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'];

export default createApplicationEslintConfig({
  rootDirectory: import.meta.dirname,
  webFiles,
  fsd: false,
  enforceLayerDirection: false,
  ignores: ['.claude/worktrees/**'],
  additionalFrameworkPackages: ['pdfjs-dist'],
  additionalConfigs: [
    {
      files: webFiles,
      plugins: { boundaries },
      settings: {
        'boundaries/include': ['src/web/**/*', 'src/app/**/*', 'src/server/**/*', 'src/i18n/**/*'],
        'boundaries/elements': [
          { type: 'server', pattern: 'src/server/**/*', partialMatch: false },
          { type: 'contracts', pattern: 'src/shared/contracts/**/*', partialMatch: false },
          { type: 'i18n', pattern: 'src/i18n/**/*', partialMatch: false },
          { type: 'app', pattern: 'src/app/**/*', partialMatch: false },
          { type: 'screens', pattern: 'src/web/screens/**/*', partialMatch: false },
          { type: 'widgets', pattern: 'src/web/widgets/**/*', partialMatch: false },
          { type: 'features', pattern: 'src/web/features/**/*', partialMatch: false },
          { type: 'entities', pattern: 'src/web/entities/**/*', partialMatch: false },
          { type: 'shared', pattern: 'src/web/shared/**/*', partialMatch: false },
        ],
      },
      rules: {
        'boundaries/dependencies': [
          'error',
          {
            default: 'disallow',
            message:
              '{{ from.element.type }} is not allowed to import {{ to.element.type }} (docs/10 §10.1).',
            policies: [
              {
                from: { element: { type: 'app' } },
                allow: {
                  to: {
                    element: {
                      types: {
                        anyOf: [
                          'screens',
                          'widgets',
                          'features',
                          'entities',
                          'shared',
                          'contracts',
                          'i18n',
                        ],
                      },
                    },
                  },
                },
              },
              {
                from: { element: { type: 'screens' } },
                allow: {
                  to: {
                    element: {
                      types: {
                        anyOf: [
                          'screens',
                          'widgets',
                          'features',
                          'entities',
                          'shared',
                          'contracts',
                        ],
                      },
                    },
                  },
                },
              },
              {
                from: { element: { type: 'widgets' } },
                allow: {
                  to: {
                    element: {
                      types: { anyOf: ['widgets', 'features', 'entities', 'shared', 'contracts'] },
                    },
                  },
                },
              },
              {
                from: { element: { type: 'features' } },
                allow: {
                  to: {
                    element: {
                      types: { anyOf: ['features', 'entities', 'shared', 'contracts'] },
                    },
                  },
                },
              },
              {
                from: { element: { type: 'entities' } },
                allow: {
                  to: { element: { types: { anyOf: ['entities', 'shared', 'contracts'] } } },
                },
              },
              {
                from: { element: { type: 'shared' } },
                allow: {
                  to: { element: { types: { anyOf: ['shared', 'contracts'] } } },
                },
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        'server/**/*.{ts,mjs}',
        'scripts/**/*.mjs',
        'src/server/**/*.ts',
        'prisma/**/*.ts',
        '*.{mjs,ts}',
      ],
      languageOptions: { globals: globals.node },
    },
  ],
});
