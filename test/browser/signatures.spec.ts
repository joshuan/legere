import { test, expect, expectResponsive, settle, settleTabNavigation } from './fixtures';
import { VISUAL_IDS } from './constants';
import type { FileSignatureDto } from '../../src/shared/contracts/signatures';

test('signatures: attach to original, inspect certificate and distinguish an earlier revision', async ({
  page,
}, info) => {
  const fileId = 'a0000000-0000-4000-8000-000000000001';
  const signature: FileSignatureDto = {
    id: 'a1111111-1111-4111-8111-111111111111',
    source: 'DETACHED',
    name: 'Government extract.pdf.sig',
    contentHash: 'b'.repeat(64),
    sizeBytes: '3834',
    createdAt: '2026-09-25T10:00:00Z',
    report: {
      version: 1,
      checkedAt: '2026-09-25T10:00:00Z',
      trust: 'NOT_CHECKED',
      coversWholeFile: null,
      signers: [
        {
          subject: 'CN=Synthetic government signing authority, O=Example public registry',
          issuer: 'CN=Example certification authority',
          serialNumber: '7F1234567890ABCDEF1234567890ABCDEF',
          certificateSha256: 'c'.repeat(64),
          validFrom: '2026-01-01T00:00:00Z',
          validTo: '2027-01-01T00:00:00Z',
          signingTime: '2026-09-25T09:00:00Z',
          digestAlgorithm: 'GOST R 34.11-2012 / 256 (1.2.643.7.1.1.2.2)',
          signatureAlgorithm: 'GOST R 34.10-2012 / 256 (1.2.643.7.1.1.1.1)',
          verification: 'VALID',
          digestMatch: true,
        },
      ],
    },
  };
  let attached = false;
  await page.route(`**/api/documents/${VISUAL_IDS.document}/signatures`, (route) =>
    route.fulfill({
      json: {
        data: {
          files: [
            {
              fileId,
              fileName: 'household-record-1.pdf',
              originalHash: 'a'.repeat(64),
              discovery: 'COMPLETE',
              signatures: attached
                ? [
                    signature,
                    {
                      ...signature,
                      id: null,
                      source: 'EMBEDDED',
                      report: {
                        ...signature.report,
                        coversWholeFile: false,
                        signers: signature.report.signers.map((signer) => ({
                          ...signer,
                          verification: 'UNSUPPORTED',
                          digestMatch: null,
                        })),
                      },
                    },
                  ]
                : [],
            },
          ],
        },
      },
    }),
  );
  await page.route(
    `**/api/documents/${VISUAL_IDS.document}/files/${fileId}/signatures`,
    async (route) => {
      expect(route.request().headers()['x-legere-filename']).toBe('Government%20extract.pdf.sig');
      expect(route.request().postDataBuffer()?.toString()).toBe('synthetic signature bytes');
      attached = true;
      await route.fulfill({ status: 201, json: { data: signature } });
    },
  );
  await page.goto(`/documents/${VISUAL_IDS.document}/files`);
  await settle(page);
  await settleTabNavigation(page);
  const section = page.getByRole('region', { name: 'Electronic signatures' });
  await section.locator('input[type=file]').setInputFiles({
    name: signature.name,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('synthetic signature bytes'),
  });
  await expect(section.getByText(signature.name, { exact: true })).toBeVisible();
  await section.getByText(signature.name, { exact: true }).click();
  await expect(section.getByText('7F1234567890ABCDEF1234567890ABCDEF')).toBeVisible();
  await expect(section.getByText('c'.repeat(64))).toBeVisible();
  await expect(section.getByText(/Certificate chains, revocation/)).toBeVisible();
  await section.getByText('Embedded PDF signature 2', { exact: true }).click();
  await expect(section.getByText(/Bytes were added after signing/)).toBeVisible();
  await expectResponsive(page);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('electronic-signatures.png'), fullPage: true });
});
