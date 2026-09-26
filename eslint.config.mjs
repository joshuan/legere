import path from 'node:path';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import { createApplicationEslintConfig } from '@joshuan/tooling/eslint';

const webFiles = ['src/web/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'];

// FSD has two distinct rules: layers point downward, and slices expose only index.ts.
// The library boundary matcher groups a whole layer; this rule additionally checks its slices,
// including type imports, re-exports and lazy imports.
const fsdSliceRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      peer: 'FSD slices in {{layer}} cannot import each other. Compose them in a higher layer.',
      upward: 'FSD dependencies point downward: {{from}} cannot import {{to}}.',
      private: 'Import {{slice}} through its public index.ts API.',
      ownBarrel: 'Inside a slice, import its modules directly instead of its public barrel.',
    },
  },
  create(context) {
    const filename = path
      .relative(import.meta.dirname, context.filename)
      .split(path.sep)
      .join('/');
    const source = filename.match(/^src\/web\/(screens|widgets|features|entities|shared)\/([^/]+)/);
    const ranks = { app: 0, screens: 1, widgets: 2, features: 3, entities: 4, shared: 5 };
    const fromLayer = source?.[1] ?? (filename.startsWith('src/app/') ? 'app' : null);
    const inspect = (node, value) => {
      if (typeof value !== 'string' || !value.startsWith('.') || fromLayer === null) return;
      const resolved = path
        .relative(import.meta.dirname, path.resolve(path.dirname(context.filename), value))
        .split(path.sep)
        .join('/');
      const target = resolved.match(
        /^src\/web\/(screens|widgets|features|entities|shared)\/([^/]+)(?:\/(.*))?$/,
      );
      if (target === null) return;
      const [, toLayer, toSlice, internal] = target;
      if (source?.[1] === toLayer && source?.[2] === toSlice) {
        if (
          (internal === undefined || /^index(?:\.[cm]?[jt]sx?)?$/.test(internal)) &&
          !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)
        )
          context.report({ node, messageId: 'ownBarrel' });
        return;
      }
      if (ranks[toLayer] < ranks[fromLayer])
        context.report({ node, messageId: 'upward', data: { from: fromLayer, to: toLayer } });
      else if (toLayer === fromLayer && toLayer !== 'shared')
        context.report({ node, messageId: 'peer', data: { layer: toLayer } });
      if (internal !== undefined && !/^index(?:\.[cm]?[jt]sx?)?$/.test(internal)) {
        // The single global stylesheet is the shared styles segment's explicit asset entry point.
        if (
          toLayer === 'shared' &&
          toSlice === 'styles' &&
          internal === 'globals.css' &&
          fromLayer === 'app'
        )
          return;
        context.report({ node, messageId: 'private', data: { slice: `${toLayer}/${toSlice}` } });
      }
    };
    return {
      ImportDeclaration: (node) => inspect(node.source, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) inspect(node.source, node.source.value);
      },
      ExportAllDeclaration: (node) => inspect(node.source, node.source.value),
      ImportExpression: (node) => inspect(node.source, node.source.value),
      TSImportType: (node) => inspect(node.source, node.source.value),
    };
  },
};

export default createApplicationEslintConfig({
  rootDirectory: import.meta.dirname,
  webFiles,
  fsd: false,
  enforceLayerDirection: false,
  ignores: ['.claude/worktrees/**', 'playwright-report/**', 'test-results/**'],
  additionalFrameworkPackages: ['pdfjs-dist'],
  additionalConfigs: [
    {
      files: webFiles,
      plugins: { boundaries, fsd: { rules: { 'slice-boundaries': fsdSliceRule } } },
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
        'fsd/slice-boundaries': 'error',
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
