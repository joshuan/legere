import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { documentApi } from './api';

// What the client refuses to send, and why here rather than there (docs/07 §7.3). Every write on
// this client parses its body against the contract the server validates with: a body that cannot be
// right is a bug where it was built, and a `422` come back from the API is the same bug reported
// somewhere nobody can act on it.

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PAGE_ID = 'cccccccc-5555-4555-8555-555555555550';
const PATH = `/api/documents/${ID}/pages/${PAGE_ID}`;

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Enough of a document for the answer to parse; the tests are about what goes *out*.
function detail(): Record<string, unknown> {
  return {
    id: ID,
    title: 'Lease',
    fileCount: 1,
    primaryExt: 'pdf',
    sizeBytes: '2048',
    pageCount: 1,
    documentType: null,
    availability: 'AVAILABLE',
    processing: false,
    origin: 'MANAGED',
    hasPreview: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    documentDate: null,
    people: [],
    subjects: [],
    country: null,
    city: null,
    languages: [],
    extractedSummary: null,
    auto: {},
    ocrUsed: false,
    description: null,
    pageFormat: 'AUTO',
    titleSource: 'NONE',
    typeSource: 'NONE',
    steps: {
      canonical: 'DONE',
      preview: 'DONE',
      markdown: 'DONE',
      analysis: 'DONE',
      fields: 'DONE',
      vectorization: 'DONE',
    },
    skipReasons: {},
    processingError: null,
    failedStep: null,
    pages: [],
    files: [],
    createdBy: null,
    extracted: null,
  };
}

describe('documentApi.updatePage', () => {
  it('sends a crop and a turn the contract accepts', async () => {
    let sent: unknown = null;
    server.use(
      http.patch(PATH, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope(detail()));
      }),
    );

    await documentApi.updatePage(ID, PAGE_ID, {
      crop: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
      turn: { quarterTurns: 1, mirrored: false },
    });

    expect(sent).toEqual({
      crop: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
      turn: { quarterTurns: 1, mirrored: false },
    });
  });

  // 🔒 A corner outside 0…1 is a bug in the crop editor — the points are normalized to the picture
  // (docs/11 §11.5c) — and it fails where it was made rather than as a `422` somebody has to
  // interpret. `onUnhandledRequest: 'error'` is the other half of the assertion: nothing left.
  it('refuses a corner outside the picture without asking the server', () => {
    expect(() =>
      documentApi.updatePage(ID, PAGE_ID, {
        crop: {
          points: [
            [0, 0],
            [1.5, 0],
            [1, 1],
            [0, 1],
          ],
        },
      }),
    ).toThrow();
  });

  // "Change nothing" is not an edit, and a PATCH that quietly did nothing would look exactly like
  // one that worked (docs/07 §7.3).
  it('refuses a body naming neither a crop nor a turn', () => {
    expect(() => documentApi.updatePage(ID, PAGE_ID, {})).toThrow();
  });
});
