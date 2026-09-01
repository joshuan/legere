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
                allow: [
                  'screens',
                  'widgets',
                  'features',
                  'entities',
                  'shared',
                  'contracts',
                  'i18n',
                ],
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
