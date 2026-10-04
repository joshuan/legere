import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HandlePageOcr } from '../../src/server/application/ocr/handle-page-ocr';
import {
  OcrProviders,
  OcrPageRenderer,
  OcrProviderError,
  PageOcrProvider,
  type OcrIdentity,
  type OcrImage,
  type OcrOptions,
} from '../../src/server/application/ports/page-ocr-provider';
import { ServiceUnavailableError } from '../../src/server/application/ports/service-unavailable';
import { PageOcrRepository } from '../../src/server/domain/repositories/page-ocr.repository';
import { normalizeYandex } from '../../src/server/infrastructure/ocr/normalize-ocr';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import {
  ocrResultSchema,
  ocrRunDtoSchema,
  ocrRunsResponseSchema,
  type OcrProviderId,
  type OcrRunDto,
} from '../../src/shared/contracts/page-ocr';
import { api, createTestApp, tokenFromFragmentUrl, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument, seedLibrary } from '../helpers/documents';
import { cookieNamed, expectData, expectError } from '../helpers/http';

class FakeOcr extends PageOcrProvider {
  configured = true;
  readonly exchange = vi.fn((_image: OcrImage): Promise<unknown> =>
    Promise.resolve({
      textAnnotation: { width: '100', height: '200', fullText: 'Invoice 42', blocks: [] },
    }),
  );
  async recognize(
    image: OcrImage,
    _options: OcrOptions,
    beforeSubmit?: () => Promise<void>,
  ): Promise<unknown> {
    await beforeSubmit?.();
    return this.exchange(image);
  }
  constructor(readonly id: OcrProviderId) {
    super();
  }
  describe() {
    return { id: this.id, configured: this.configured, model: 'test-version-1' };
  }
  normalize(raw: unknown, input: OcrIdentity) {
    return { ...normalizeYandex(raw, input), provider: this.id };
  }
}
class FakeRenderer extends OcrPageRenderer {
  readonly render = vi.fn((key: string, page: number) => {
    const bytes = Buffer.from(`${key}:${page}`);
    return Promise.resolve({
      bytes,
      width: 100,
      height: 200,
      dpi: 300,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });
  });
}

describe('Page OCR inspection (e2e)', () => {
  let app: TestApp;
  let admin: string;
  let userId: string;
  let reader: string;
  let sequence = 0;
  let documentId: string;
  let pageIds: string[];
  const google = new FakeOcr('google-document-ai');
  const yandex = new FakeOcr('yandex-vision');
  const renderer = new FakeRenderer();
  let handler: HandlePageOcr;
  let repository: PageOcrRepository;

  beforeAll(async () => {
    app = await createTestApp({
      ocrProviders: new OcrProviders([google, yandex]),
      ocrRenderer: renderer,
    });
    handler = app.nestApp.get(HandlePageOcr);
    repository = app.nestApp.get(PageOcrRepository);
  });
  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    vi.clearAllMocks();
    google.configured = true;
    yandex.configured = true;
    sequence += 1;
    admin = (await onboard(`admin${sequence}@ocr.test`)).cookie;
    const invited = expectData(
      await api(app).post('/api/admin/invites', { role: 'USER' }).set('Cookie', admin),
      createInviteResponseSchema,
    );
    const user = await onboard(`reader${sequence}@ocr.test`, tokenFromFragmentUrl(invited.url));
    userId = user.id;
    reader = user.cookie;
    const libraryId = await seedLibrary();
    const seeded = await seedDocument({
      libraryId,
      document: { pageCount: 2, languages: ['en'], markdown: 'Existing searchable text' },
      files: [{ pageCount: 2 }],
    });
    documentId = seeded.id;
    pageIds = (
      await testPrisma().documentPage.findMany({
        where: { documentId },
        orderBy: { position: 'asc' },
      })
    ).map((page) => page.id);
    await testPrisma().document.update({
      where: { id: documentId },
      data: { canonicalPageIds: pageIds },
    });
  });
  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function onboard(email: string, inviteToken?: string) {
    const invitation = inviteToken === undefined ? {} : { inviteToken };
    await api(app).post('/api/auth/register/start', { email, ...invitation });
    const verified = expectData(
      await api(app).post('/api/auth/register/verify', {
        email,
        ...invitation,
        code: app.emails.lastCodeFor(email),
      }),
      registerVerifyResponseSchema,
    );
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: verified.ticket,
      password: 'a-decent-passphrase',
    });
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('Missing session');
    return { cookie, id: expectData(completed, userDtoSchema).id };
  }
  const path = () => `/api/documents/${documentId}`;
  async function start(overrides: object = {}): Promise<OcrRunDto> {
    return expectData(
      await api(app)
        .post(`${path()}/ocr-runs`, {
          requestId: randomUUID(),
          providers: ['google-document-ai', 'yandex-vision'],
          ...overrides,
        })
        .set('Cookie', admin),
      ocrRunDtoSchema,
    );
  }
  async function finish(run: OcrRunDto) {
    await Promise.all(run.pages.map((page) => handler.handle({ resultId: page.id })));
  }
  async function get(run: OcrRunDto) {
    return expectData(
      await api(app).get(`${path()}/ocr-runs/${run.id}`).set('Cookie', reader),
      ocrRunDtoSchema,
    );
  }
  function first(run: OcrRunDto) {
    const page = run.pages[0];
    if (page === undefined) throw new Error('Empty run');
    return page;
  }

  it('manually queues both providers, shares identical rasters and leaves search/pipeline data unchanged', async () => {
    const before = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
    const run = await start();
    expect(run.pages).toHaveLength(4);
    const jobs = await testPrisma().$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(*) AS count FROM pgboss.job WHERE name = 'page-ocr'`;
    expect(jobs[0]?.count).toBe(4n);
    await finish(run);
    expect((await get(run)).pages.every((page) => page.status === 'DONE')).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(google.exchange.mock.calls.map(([image]) => image.hash)).toEqual(
      yandex.exchange.mock.calls.map(([image]) => image.hash),
    );
    expect(await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } })).toEqual(
      before,
    );
    const resultId = first(run).id;
    expect(
      expectData(
        await api(app).get(`${path()}/ocr-results/${resultId}`).set('Cookie', reader),
        ocrResultSchema,
      ).fullText,
    ).toBe('Invoice 42');
    for (const kind of ['raw', 'json', 'image']) {
      const response = await api(app)
        .get(`${path()}/ocr-results/${resultId}/${kind}`)
        .set('Cookie', reader);
      expect(response.status).toBe(302);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('reuses submission IDs and caches successful images, with an explicit fresh-call override', async () => {
    const requestId = randomUUID();
    const run = await start({ requestId });
    expect((await start({ requestId })).id).toBe(run.id);
    expect(await testPrisma().ocrRun.count()).toBe(1);
    await finish(run);
    const cached = await start();
    await finish(cached);
    expect(
      (await get(cached)).pages.every((page) => page.cached && page.submittedAttempts === 0),
    ).toBe(true);
    expect(google.exchange).toHaveBeenCalledTimes(2);
    const forced = await start({ force: true, pageIds: [pageIds[0]] });
    await finish(forced);
    expect(google.exchange).toHaveBeenCalledTimes(3);
    expect((await get(forced)).pages.every((page) => !page.cached)).toBe(true);
  });

  it('serializes concurrent identical runs before the paid call', async () => {
    const one = await start({ pageIds: [pageIds[0]], providers: ['google-document-ai'] });
    const two = await start({ pageIds: [pageIds[0]], providers: ['google-document-ai'] });
    await Promise.all([finish(one), finish(two)]);
    expect(google.exchange).toHaveBeenCalledTimes(1);
  });

  it('retains raw JSON when parsing fails and retries only failed results without another call', async () => {
    google.exchange.mockResolvedValueOnce({ unsupported: 'provider response version' });
    const run = await start({ pageIds: [pageIds[0]] });
    await Promise.allSettled(run.pages.map((page) => handler.handle({ resultId: page.id })));
    const failed = (await get(run)).pages.find((page) => page.status === 'FAILED');
    expect(failed?.hasRaw).toBe(true);
    expect(failed?.error).toContain('original JSON is retained');
    // Simulate a parser repair reading the persisted provider payload.
    const repair = vi.spyOn(google, 'normalize').mockImplementation((_raw, input) => ({
      ...input,
      schemaVersion: 1,
      provider: 'google-document-ai',
      fullText: 'Recovered',
      elements: [],
    }));
    await api(app).post(`${path()}/ocr-runs/${run.id}/retry`).set('Cookie', admin).expect(201);
    await finish(run);
    expect((await get(run)).pages.every((page) => page.status === 'DONE')).toBe(true);
    expect(google.exchange).toHaveBeenCalledTimes(1);
    expect(yandex.exchange).toHaveBeenCalledTimes(1);
    repair.mockRestore();
  });

  it('retries transient failures, retains permanent failures and reports potentially billed submissions', async () => {
    google.exchange.mockRejectedValueOnce(
      new ServiceUnavailableError('google-document-ai', 'connection interrupted'),
    );
    const run = await start({ pageIds: [pageIds[0]], providers: ['google-document-ai'] });
    await expect(finish(run)).rejects.toThrow('interrupted');
    expect(first(await get(run))).toMatchObject({ status: 'QUEUED', submittedAttempts: 1 });
    await finish(run);
    expect(first(await get(run))).toMatchObject({ status: 'DONE', submittedAttempts: 2 });
    const permanent = await start({
      force: true,
      providers: ['yandex-vision'],
      pageIds: [pageIds[0]],
    });
    yandex.exchange.mockRejectedValueOnce(new OcrProviderError('OCR HTTP 403', false));
    await expect(finish(permanent)).rejects.toThrow('403');
    await expect(finish(permanent)).rejects.toThrow('403');
    expect(yandex.exchange).toHaveBeenCalledTimes(1);
    const exhausted = await start({
      force: true,
      providers: ['google-document-ai'],
      pageIds: [pageIds[0]],
    });
    google.exchange.mockRejectedValueOnce(
      new ServiceUnavailableError('google-document-ai', 'offline'),
    );
    await expect(
      handler.handle({ resultId: first(exhausted).id }, { retryCount: 5 }),
    ).rejects.toThrow();
    expect(first(await get(exhausted)).status).toBe('FAILED');
  });

  it('fences stale workers and recovers expired leases', async () => {
    const run = await start({ pageIds: [pageIds[0]], providers: ['google-document-ai'] });
    const id = first(run).id;
    const token = randomUUID();
    expect(await repository.claim(id, token, new Date())).toBe(true);
    await repository.heartbeat(id, token);
    await expect(finish(run)).rejects.toThrow('leased');
    expect(google.exchange).not.toHaveBeenCalled();
    await testPrisma().ocrPageResult.update({ where: { id }, data: { leaseUntil: new Date(0) } });
    await finish(run);
    expect(await repository.update(id, token, { status: 'FAILED' })).toBe(false);
    expect(await repository.submitted(id, token)).toBe(false);
    expect(first(await get(run)).status).toBe('DONE');
  });

  it('keeps old page identities and images after a canonical rebuild', async () => {
    const old = await start();
    await finish(old);
    await testPrisma().document.update({
      where: { id: documentId },
      data: {
        canonicalStorageKey: `documents/${documentId}/canonical/revision2.pdf`,
        canonicalPageIds: [...pageIds].reverse(),
      },
    });
    expect((await get(old)).stale).toBe(true);
    const download = await api(app).get(`${path()}/canonical`).set('Cookie', reader);
    expect(download.status).toBe(302);
    expect(download.headers.location).toContain(`/canonical/revision2.pdf`);
    const fresh = await start();
    await finish(fresh);
    expect(first(fresh).pageId).toBe(pageIds[1]);
    expect(first(old).pageId).toBe(pageIds[0]);
    expect(first(await get(fresh)).cached).toBe(false);
    expect(renderer.render).toHaveBeenCalledWith(
      `documents/${documentId}/canonical/revision2.pdf`,
      1,
    );
  });

  it('serves a local page preview on GET without submitting any cloud work', async () => {
    const response = await api(app)
      .get(`${path()}/ocr-pages/${pageIds[0]}/image`)
      .set('Cookie', reader);
    expect(response.status).toBe(302);
    await api(app).get(`${path()}/ocr-pages/${pageIds[0]}/image`).set('Cookie', reader).expect(302);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(google.exchange).not.toHaveBeenCalled();
    expect(yandex.exchange).not.toHaveBeenCalled();
    expect(
      expectData(
        await api(app).get(`${path()}/ocr-runs`).set('Cookie', reader),
        ocrRunsResponseSchema,
      ).pages.map((page) => page.id),
    ).toEqual(pageIds);
  });

  it('enforces authentication, admin submission and document-scoped artifacts', async () => {
    const body = { requestId: randomUUID(), providers: ['google-document-ai'] };
    await api(app).get(`${path()}/ocr-runs`).expect(401);
    await api(app).post(`${path()}/ocr-runs`, body).set('Cookie', reader).expect(403);
    const run = await start();
    await finish(run);
    await api(app).post(`${path()}/ocr-runs/${run.id}/retry`).set('Cookie', reader).expect(403);
    const other = await seedDocument({
      libraryId: await seedLibrary({ visibility: 'RESTRICTED' }),
    });
    await api(app).get(`/api/documents/${other.id}/ocr-runs`).set('Cookie', reader).expect(404);
    for (const suffix of [
      `ocr-runs/${run.id}`,
      `ocr-results/${first(run).id}`,
      `ocr-results/${first(run).id}/raw`,
    ]) {
      await api(app).get(`/api/documents/${other.id}/${suffix}`).set('Cookie', admin).expect(404);
    }
    await api(app).get(`${path()}/ocr-results/not-a-uuid`).set('Cookie', admin).expect(404);
    await api(app)
      .get(`${path()}/ocr-results/${first(run).id}/secret`)
      .set('Cookie', admin)
      .expect(404);
    await api(app)
      .get(`${path()}/ocr-pages/${randomUUID()}/image`)
      .set('Cookie', admin)
      .expect(404);
    // Role checks do not depend on first-user initialization.
    expect(
      await testPrisma()
        .user.findUniqueOrThrow({ where: { id: userId } })
        .then((user) => user.role),
    ).toBe('USER');
  });

  it('rejects unavailable providers, unbuilt pages and unknown selections without jobs', async () => {
    google.configured = false;
    const body = { requestId: randomUUID(), providers: ['google-document-ai'] };
    expect(
      expectError(await api(app).post(`${path()}/ocr-runs`, body).set('Cookie', admin)).code,
    ).toBe('OCR_NOT_CONFIGURED');
    google.configured = true;
    await api(app)
      .post(`${path()}/ocr-runs`, { ...body, pageIds: [randomUUID()] })
      .set('Cookie', admin)
      .expect(404);
    await testPrisma().document.update({
      where: { id: documentId },
      data: { canonicalStatus: 'RUNNING' },
    });
    expect(
      expectError(await api(app).post(`${path()}/ocr-runs`, body).set('Cookie', admin)).code,
    ).toBe('CANONICAL_NOT_READY');
    await api(app).get(`${path()}/ocr-pages/${pageIds[0]}/image`).set('Cookie', admin).expect(409);
    expect(await testPrisma().ocrRun.count()).toBe(0);
  });

  it('returns not-ready for pending artifacts and tolerates document deletion before delivery', async () => {
    const run = await start();
    await api(app)
      .get(`${path()}/ocr-results/${first(run).id}`)
      .set('Cookie', admin)
      .expect(409);
    await api(app)
      .get(`${path()}/ocr-results/${first(run).id}/raw`)
      .set('Cookie', admin)
      .expect(409);
    await testPrisma().document.delete({ where: { id: documentId } });
    await finish(run);
    expect(await testPrisma().ocrRun.count()).toBe(0);
    expect(await testPrisma().ocrPageResult.count()).toBe(0);
    expect(google.exchange).not.toHaveBeenCalled();
  });

  it('validates request boundaries', async () => {
    for (const providers of [
      [],
      ['other'],
      ['google-document-ai', 'yandex-vision', 'google-document-ai'],
    ]) {
      await api(app)
        .post(`${path()}/ocr-runs`, { requestId: randomUUID(), providers })
        .set('Cookie', admin)
        .expect(422);
    }
    const result = await api(app).get(`${path()}/ocr-runs`).set('Cookie', admin);
    expect(expectData(result, z.object({ runs: z.array(z.unknown()) })).runs).toEqual([]);
  });
});
