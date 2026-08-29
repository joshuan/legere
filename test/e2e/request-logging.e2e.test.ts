import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import { uploadDocumentResponseSchema } from '../../src/shared/contracts/documents';
import {
  createInviteResponseSchema,
  createPasswordResetResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');
// Bytes of its own: an upload of the same content deduplicates onto the document that already holds
// it (docs/05 §5.1a), which would hand the download tests below the name from the upload test above.
const OTHER_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 >>\nendobj\n%%EOF\n');

// 🔒 SEC-10 (docs/06 §6.7, docs/08 §8.1.2, §8.1.6). Two links this application hands out are bearer
// credentials living in a path segment, and `pino-http` writes the URL of every request it serves.
// The suite therefore reads what the process actually emitted rather than what a serializer returns
// in isolation: the request log runs through Express, Nest, a guard and a throttler first, and the
// question is what comes out the far end.
describe('Request logging (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let inviteToken: string;
  let resetToken: string;
  const emitted: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;

  // The whole suite runs at `info` — the level the shipped deployment runs at (docs/12 §12.4) —
  // and stdout is captured before the app is built, because pino chooses its destination when the
  // middleware is created and a spy installed later would see nothing.
  beforeAll(async () => {
    process.env.LOG_LEVEL = 'info';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      emitted.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    app = await createTestApp();
    await truncateAll();
    adminCookie = await onboard('log-admin@legere.local');

    const invite = expectData(
      await api(app).post('/api/admin/invites', { role: 'USER' }).set('Cookie', adminCookie),
      createInviteResponseSchema,
    );
    inviteToken = tokenFrom(invite.url);

    const admin = await testPrisma().user.findFirstOrThrow();
    const reset = expectData(
      await api(app).post(`/api/admin/users/${admin.id}/password-reset`).set('Cookie', adminCookie),
      createPasswordResetResponseSchema,
    );
    resetToken = tokenFrom(reset.url);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
    await app.close();
    await disconnectTestPrisma();
  });

  async function onboard(email: string): Promise<string> {
    await api(app).post('/api/auth/register/start', { email });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('onboarding did not set a session cookie');
    return sid;
  }

  function tokenFrom(url: string): string {
    const token = url.split('/').pop();
    if (token === undefined || token === '') throw new Error(`No token in ${url}`);
    return token;
  }

  const log = () => emitted.join('');

  it('writes the route and not the token when an invite link is previewed', async () => {
    const before = log();
    const preview = await api(app).get(`/api/invites/${inviteToken}`);

    expect(preview.status).toBe(200);
    const written = log().slice(before.length);
    // The request was logged — otherwise "the token is absent" would pass for the wrong reason.
    expect(written).toContain('"url":"/api/invites/:x"');
    expect(written).not.toContain(inviteToken);
  });

  it('writes the route and not the token when a reset link is previewed', async () => {
    const before = log();
    const preview = await api(app).get(`/api/password-resets/${resetToken}`);

    expect(preview.status).toBe(200);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/password-resets/:x"');
    expect(written).not.toContain(resetToken);
  });

  // 🔒 SEC-23 on the request half of the line (docs/06 §6.7). The headers used to travel whole
  // behind a deny-list of four names; the header nobody would have added to it is `Referer`, which
  // a client following an invite link out of a chat window sends — `Referrer-Policy: no-referrer`
  // (docs/12 §12.8a) is a rule about browsers, and the link is a bearer credential in a path.
  it('writes no Referer, not even when the Referer is the invite link itself', async () => {
    const before = log();
    const preview = await api(app)
      .get(`/api/invites/${inviteToken}`)
      .set('Referer', `http://localhost:3000/invite/${inviteToken}`)
      .set('User-Agent', 'legere-e2e');

    expect(preview.status).toBe(200);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/invites/:x"');
    expect(written).not.toContain(inviteToken);
    expect(written).not.toContain('referer');
    // What a request line still says about a caller, so this does not pass by logging nothing.
    expect(written).toContain('"user-agent":"legere-e2e"');
  });

  it('keeps neither token anywhere in everything the process has emitted', () => {
    expect(log()).not.toContain(inviteToken);
    expect(log()).not.toContain(resetToken);
  });

  it('never says what somebody searched their archive for', async () => {
    const before = log();
    const found = await api(app).get('/api/search?q=biopsy-results').set('Cookie', adminCookie);

    expect(found.status).toBe(200);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/search"');
    expect(written).not.toContain('biopsy-results');
  });

  it('never says what a document is called', async () => {
    const before = log();
    const uploaded = await api(app)
      .postBinary('/api/documents', PDF)
      .set('Cookie', adminCookie)
      .set('X-Legere-Filename', encodeURIComponent('biopsy results 2026.pdf'));

    expect(uploaded.status).toBe(201);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/documents"');
    expect(written).not.toContain('biopsy');
  });

  // 🔒 SEC-58 (docs/06 §6.7, docs/09 §9.2). The upload above only ever exercised the request half:
  // no response it produces carries a `Content-Disposition`, and none of them redirects. What a
  // *download* answers with is a presigned URL — a credential for the bytes, with no session behind
  // it — and the file's own name, on both of the two ways bytes leave Legere.
  describe('a download', () => {
    let documentId: string;
    let fileId: string;

    beforeAll(async () => {
      const uploaded = expectData(
        await api(app)
          .postBinary('/api/documents', OTHER_PDF)
          .set('Cookie', adminCookie)
          .set('X-Legere-Filename', encodeURIComponent('cardiology 2026.pdf')),
        uploadDocumentResponseSchema,
      );
      documentId = uploaded.document.id;

      const file = await testPrisma().file.findFirstOrThrow({
        where: { pages: { some: { documentId } } },
      });
      fileId = file.id;

      // The pipeline is not running in this suite, so the canonical is put where a finished build
      // would have left it — this is about the response, not about how the object got there.
      await app.files.put(artifactKeys.canonicalPdf(documentId), OTHER_PDF, 'application/pdf');
      await testPrisma().document.update({
        where: { id: documentId },
        data: { canonicalStatus: 'DONE' },
      });
    });

    it('writes neither the signed URL nor the file name on the redirect branch', async () => {
      const before = log();
      const redirected = await api(app)
        .get(`/api/documents/${documentId}/files/${fileId}/content`)
        .set('Cookie', adminCookie)
        .redirects(0);

      // The response really did carry both — otherwise this passes for the wrong reason.
      expect(redirected.status).toBe(302);
      expect(redirected.headers.location).toContain('X-Amz-');
      expect(redirected.headers['content-disposition']).toContain('cardiology');

      const written = log().slice(before.length);
      expect(written).toContain('"url":"/api/documents/:x/files/:x/content"');
      expect(written).not.toContain('X-Amz-');
      expect(written).not.toContain('in-memory-storage.test');
      expect(written).not.toContain('cardiology');
    });

    it('writes neither of them on the streamed branch either', async () => {
      const before = log();
      const saved = await api(app)
        .get(`/api/documents/${documentId}/canonical?download=1`)
        .set('Cookie', adminCookie);

      expect(saved.status).toBe(200);
      expect(saved.headers['content-disposition']).toContain('cardiology');

      const written = log().slice(before.length);
      expect(written).toContain('"url":"/api/documents/:x/canonical"');
      expect(written).not.toContain('cardiology');
      // What a line may still say about an answer: how it ended, and of what kind.
      expect(written).toContain('"content-type":"application/pdf"');
    });
  });
});
