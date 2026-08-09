import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FILENAME_HEADER, isRawBodyRoute, uploadFileName } from './read-upload-body';

// The header is read off a real request, because that is the only way `req.headers` behaves the way
// the function expects — arrays for repeats, lowercased names, no decoding done for us.
function nameFrom(header: string): Promise<string> {
  const app: Express = express();
  app.post('/upload', (req, res) => {
    res.json({ name: uploadFileName(req) });
  });

  return request(app)
    .post('/upload')
    .set(FILENAME_HEADER, header)
    .then((response) => {
      const body: unknown = response.body;
      if (typeof body !== 'object' || body === null || !('name' in body)) {
        throw new Error('the probe route answered something unexpected');
      }
      const { name } = body;
      if (typeof name !== 'string') throw new Error('the probe route answered a non-string name');
      return name;
    });
}

describe('uploadFileName', () => {
  it('keeps an ordinary name', async () => {
    expect(await nameFrom('invoice.pdf')).toBe('invoice.pdf');
  });

  it('keeps only the last segment of a path', async () => {
    expect(await nameFrom('..%2F..%2Fetc%2Fpasswd')).toBe('passwd');
    expect(await nameFrom('C%3A%5CUsers%5Cme%5Cscan.pdf')).toBe('scan.pdf');
  });

  // 🔒 The regression this exists for: `.` in a JavaScript regular expression does not match a
  // newline, so a percent-encoded one truncated the strip and the name came out still carrying `..`
  // and a separator — into a document title, and into another container's multipart part.
  it('is not fooled by a newline into keeping a path', async () => {
    expect(await nameFrom('%0A..%2F..%2Fx.evil')).toBe('x.evil');
    expect(await nameFrom('a%2Fb%0Ac.d%2Fe')).toBe('e');
  });

  it('carries no control character through at all', async () => {
    const name = await nameFrom('in%00voi%09ce%0D%0A.pdf');

    expect(name).toBe('invoice.pdf');
  });

  it('keeps a name a person actually wrote', async () => {
    expect(await nameFrom(encodeURIComponent('Счёт №12 (копия).pdf'))).toBe('Счёт №12 (копия).pdf');
  });

  it('bounds the length', async () => {
    expect((await nameFrom(`${'x'.repeat(400)}.pdf`)).length).toBe(255);
  });
});

// 🔒 Both routes that read the body raw, and nothing else (docs/05 §5.1a). The list is what the
// wiring in server/main.ts exempts from the body parsers; a route that reads the body raw and is not
// here answers "the uploaded file is empty".
describe('isRawBodyRoute', () => {
  it('names every route whose body is the file itself', () => {
    expect(isRawBodyRoute('POST', '/documents')).toBe(true);
    expect(isRawBodyRoute('POST', '/documents/11111111-1111-4111-8111-111111111111/files')).toBe(
      true,
    );
  });

  it('leaves every other route to the parsers', () => {
    // Same path, a method that sends JSON.
    expect(isRawBodyRoute('PATCH', '/documents/11111111-1111-4111-8111-111111111111/files')).toBe(
      false,
    );
    expect(isRawBodyRoute('GET', '/documents')).toBe(false);
    expect(isRawBodyRoute('POST', '/documents/11111111-1111-4111-8111-111111111111/combine')).toBe(
      false,
    );
    expect(isRawBodyRoute('POST', '/collections')).toBe(false);
    // Not a prefix match: a route that merely starts the same way is somebody else's.
    expect(isRawBodyRoute('POST', '/documents/x/files/y')).toBe(false);
  });
});
