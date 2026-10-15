import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentDetailDto, DocumentFileDto } from '../../../../shared/contracts/documents';
import type { FileSignatureDto } from '../../../../shared/contracts/signatures';
import { createApiMock, envelope } from '../../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../../test/helpers/render';
import { SignatureBadge, SignaturesSection } from './signatures-section';

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const LIBRARY_ID = 'cccccccc-3333-4333-8333-333333333333';
const FIRST_FILE = 'ffffffff-1111-4111-8111-111111111111';
const SECOND_FILE = 'ffffffff-2222-4222-8222-222222222222';
const server = createApiMock();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function fileOf(id: string, overrides: Partial<DocumentFileDto> = {}): DocumentFileDto {
  return {
    id,
    position: 0,
    name: 'rental.pdf',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: '2097152',
    origin: 'LIBRARY',
    available: true,
    isImage: false,
    crop: null,
    cropSource: 'NONE',
    rotation: null,
    // The pages as they arrived, and nobody has counted them (docs/03 §3.3.16).
    pageOrder: null,
    pageRotations: null,
    pageCount: null,
    refs: [
      { libraryId: LIBRARY_ID, libraryName: 'Invoices', path: 'a/rental.pdf', status: 'HASHED' },
    ],
    // A library file's bytes stay on the volume, so it has no object at all (docs/09 §9.2).
    storageKey: null,
    // A page nobody has re-photographed has had no other copies (docs/05 §5.6).
    earlierVersions: [],
    ...overrides,
  };
}

// The document as the ordered list of pages it is (docs/03 §3.3.17): one entry per file here,
// because nobody has counted the pages inside any of them yet.
function pagesOf(...fileIds: string[]): DocumentDetailDto['pages'] {
  return fileIds.map((fileId, position) => ({
    id: `eeeeeeee-0000-4000-8000-00000000000${position}`,
    position,
    fileId,
    pageIndex: null,
    turn: null,
    crop: null,
    cropSource: 'NONE' as const,
  }));
}

const detail: DocumentDetailDto = {
  previewPageId: null,
  previewRevision: 0,
  id: ID,
  title: 'Rental agreement',
  fileCount: 1,
  primaryExt: 'pdf',
  sizeBytes: '2097152',
  pageCount: 4,
  documentType: null,
  availability: 'AVAILABLE',
  processing: false,
  origin: 'LIBRARY',
  hasPreview: true,
  createdAt: '2026-01-02T10:00:00.000Z',
  ocrUsed: true,
  description: null,
  pageFormat: 'AUTO',
  titleSource: 'NONE',
  typeSource: 'NONE',
  skipReasons: {},
  auto: {},
  people: [],
  documentDate: null,
  subjects: [],
  languages: ['ru', 'sr-Latn'],
  country: 'ME',
  city: 'Podgorica',
  steps: {
    canonical: 'DONE',
    preview: 'DONE',
    markdown: 'DONE',
    analysis: 'DONE',
    fields: 'DONE',
    vectorization: 'SKIPPED',
  },
  processingError: null,
  failedStep: null,
  pages: pagesOf(FIRST_FILE),
  files: [fileOf(FIRST_FILE)],
  createdBy: null,
  extracted: null,
  extractedSummary: null,
};

// Signature status is about the original bytes. The viewer must not turn unverified metadata or
// an earlier PDF revision into a promise that the assembled document is certified.
describe('electronic signatures in the viewer', () => {
  const signature: FileSignatureDto = {
    id: 'a1111111-1111-4111-8111-111111111111',
    source: 'DETACHED',
    name: 'rental.pdf.sig',
    contentHash: 'b'.repeat(64),
    sizeBytes: '100',
    createdAt: '2026-10-15T10:00:00Z',
    report: {
      version: 1,
      checkedAt: '2026-10-15T10:00:00Z',
      coversWholeFile: null,
      trust: 'NOT_CHECKED',
      signers: [
        {
          subject: 'CN=Synthetic authority',
          issuer: 'CN=Example CA',
          serialNumber: 'A1B2',
          certificateSha256: 'c'.repeat(64),
          validFrom: '2025-01-01T00:00:00Z',
          validTo: '2035-01-01T00:00:00Z',
          signingTime: '2026-10-15T09:00:00Z',
          digestAlgorithm: 'GOST R 34.11-2012 / 256',
          signatureAlgorithm: 'GOST R 34.10-2012 / 256',
          verification: 'VALID',
          digestMatch: true,
        },
      ],
    },
  };
  const payload = (signatures: FileSignatureDto[] = [signature], discovery = 'COMPLETE') => ({
    files: [
      {
        fileId: FIRST_FILE,
        fileName: 'rental.pdf',
        originalHash: 'a'.repeat(64),
        discovery,
        signatures,
      },
    ],
  });
  function serveSignatures(body = payload()) {
    server.use(
      http.get(`/api/documents/${ID}/signatures`, () => HttpResponse.json(envelope(body))),
    );
  }

  it('shows original signature badges and certificate identifiers with an explicit trust limitation', async () => {
    serveSignatures();
    renderWithProviders(
      <>
        <SignatureBadge document={detail} />
        <SignaturesSection document={detail} isAdmin />
      </>,
    );
    expect(await screen.findByText('Original signatures: 1')).toBeInTheDocument();
    expect(screen.getByText('Original signatures: 1').closest('a')).toHaveAttribute(
      'href',
      `/documents/${ID}/files`,
    );
    await userEvent.click(await screen.findByText(signature.name));
    expect(await screen.findByText('A1B2')).toBeInTheDocument();
    expect(screen.getByText('c'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText(enMessages.viewer.signatures.trustNote)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: enMessages.viewer.signatures.download }),
    ).toHaveAttribute(
      'href',
      `/api/documents/${ID}/files/${FIRST_FILE}/signatures/${signature.id}/content`,
    );
  });
  it('uploads against the explicitly selected original and refreshes signature state', async () => {
    let uploadedPath = '';
    server.use(
      http.post('/api/documents/:id/files/:fileId/signatures', ({ params }) => {
        uploadedPath = String(params.fileId);
        return HttpResponse.json(envelope(signature), { status: 201 });
      }),
    );
    serveSignatures(payload([]));
    const twoFiles = {
      ...detail,
      files: [fileOf(FIRST_FILE), fileOf(SECOND_FILE, { name: 'second.pdf' })],
    };
    const rendered = renderWithProviders(<SignaturesSection document={twoFiles} isAdmin />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByTitle('second.pdf'));
    const input = rendered.container.querySelector('input[type=file]');
    if (!(input instanceof HTMLInputElement)) throw new Error('No signature picker');
    await userEvent.upload(
      input,
      new File(['signature bytes'], 'second.pdf.sig', { type: 'application/octet-stream' }),
    );
    await waitFor(() => expect(uploadedPath).toBe(SECOND_FILE));
    expect(await screen.findByText(enMessages.viewer.signatures.attached)).toBeInTheDocument();
  });
  it('keeps unsupported algorithms and earlier revisions visibly unverified', async () => {
    const signer = signature.report.signers[0];
    if (signer === undefined) throw new Error('No fixture signer');
    serveSignatures(
      payload([
        {
          ...signature,
          source: 'EMBEDDED',
          id: null,
          report: {
            ...signature.report,
            coversWholeFile: false,
            signers: [{ ...signer, verification: 'UNSUPPORTED', digestMatch: null }],
          },
        },
      ]),
    );
    renderWithProviders(<SignaturesSection document={detail} isAdmin />);
    expect(
      await screen.findByText(enMessages.viewer.signatures.verification.UNSUPPORTED),
    ).toBeInTheDocument();
    expect(screen.getByText(enMessages.viewer.signatures.earlierRevision)).toBeInTheDocument();
    expect(
      screen.queryByText(enMessages.viewer.signatures.verification.VALID),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Embedded PDF signature 1'));
    expect(
      await screen.findByText(enMessages.viewer.signatures.changedAfterSigning),
    ).toBeInTheDocument();
  });
  it('offers retry when discovery fails and does not call the original unsigned', async () => {
    serveSignatures(payload([], 'ERROR'));
    renderWithProviders(<SignaturesSection document={detail} isAdmin />);
    expect(
      await screen.findByText(enMessages.viewer.signatures.discovery.ERROR),
    ).toBeInTheDocument();
    expect(screen.queryByText(enMessages.viewer.signatures.unsigned)).not.toBeInTheDocument();
    serveSignatures(payload([]));
    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.signatures.retry }));
    expect(await screen.findByText(enMessages.viewer.signatures.unsigned)).toBeInTheDocument();
  });
  it('hides attachment mutations in a read-only document peek', async () => {
    serveSignatures();
    renderWithProviders(<SignaturesSection document={detail} isAdmin readOnly />);
    await userEvent.click(await screen.findByText(signature.name));
    expect(
      screen.queryByRole('button', { name: enMessages.viewer.signatures.attach }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enMessages.viewer.signatures.remove }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: enMessages.viewer.signatures.download }),
    ).toBeInTheDocument();
  });
});
