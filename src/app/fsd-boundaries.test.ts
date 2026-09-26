import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

let eslint: ESLint;

beforeAll(async () => {
  const configured = new ESLint();
  // ESLint's public signature returns any although this is the same flat config consumed by lint.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const config: Linter.Config = await configured.calculateConfigForFile(
    'src/web/screens/documents/index.ts',
  );
  expect(config?.rules?.['fsd/slice-boundaries']).toEqual([2]);
  const fsd = config.plugins?.fsd;
  if (fsd === undefined) throw new Error('The configured FSD plugin must be enabled');
  eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser },
      plugins: { fsd },
      rules: { 'fsd/slice-boundaries': 'error' },
    },
  });
});

// Exercise the configured rule, so a future config change cannot silently permit peer/private imports.
describe('frontend slice boundaries', () => {
  it('rejects peer slices, upward dependencies, deep imports and private re-exports', async () => {
    const cases = [
      [
        'src/web/screens/documents/documents-screen.tsx',
        "import { ReceiptsScreen } from '../receipts';",
        'peer',
      ],
      [
        'src/web/shared/ui/query-error.tsx',
        "import { documentApi } from '../../entities/document';",
        'upward',
      ],
      [
        'src/web/screens/documents/documents-screen.tsx',
        "import { documentApi } from '../../entities/document/api';",
        'private',
      ],
      [
        'src/web/screens/documents/documents-screen.tsx',
        "export { documentApi } from '../../entities/document/api';",
        'private',
      ],
      [
        'src/web/screens/documents/documents-screen.tsx',
        "void import('../../entities/document/api');",
        'private',
      ],
      [
        'src/web/screens/documents/documents-screen.tsx',
        "export type { DocumentListOptions } from '../../entities/document/api';",
        'private',
      ],
      [
        'src/web/screens/documents/documents-screen.tsx',
        "import type { ReceiptFilters } from '../receipts';",
        'peer',
      ],
      [
        'src/web/screens/documents/documents-screen.tsx',
        "type Options = import('../../entities/document/api').DocumentListOptions;",
        'private',
      ],
      [
        'src/web/shared/ui/responsive-table.tsx',
        "import { ResponsiveTable } from '.';",
        'ownBarrel',
      ],
      [
        'src/web/widgets/document-viewer/ui/text-pane.tsx',
        "import { DocumentViewer } from '../index';",
        'ownBarrel',
      ],
    ] as const;
    for (const [filePath, code, messageId] of cases) {
      const results = await eslint.lintText(code, { filePath });
      expect(
        results
          .flatMap((result) => result.messages)
          .some(
            (message) =>
              message.ruleId === 'fsd/slice-boundaries' && message.messageId === messageId,
          ),
      ).toBe(true);
    }
  });

  it('allows a lower-layer public API and internal same-slice modules', async () => {
    const results = await eslint.lintText(
      "import { documentApi } from '../../entities/document'; import { DocumentsScreen } from './documents-screen';",
      { filePath: 'src/web/screens/documents/index.ts' },
    );
    expect(
      results
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === 'fsd/slice-boundaries'),
    ).toEqual([]);
    const publicApiTest = await eslint.lintText("import { ResponsiveTable } from '.';", {
      filePath: 'src/web/shared/ui/responsive-table.test.tsx',
    });
    expect(publicApiTest.flatMap((result) => result.messages)).toEqual([]);
  });
});
