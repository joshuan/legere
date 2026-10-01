import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import {
  integrationSchema,
  integrationTokenResponseSchema,
  integrationUploadResponseSchema,
  integrationDocumentListSchema,
  integrationDocumentSchema,
  integrationArtifactSchema,
  listIntegrationsSchema,
} from '../../src/shared/contracts/integrations';
import {
  documentDetailDtoSchema,
  documentEventPageSchema,
  uploadDocumentResponseSchema,
} from '../../src/shared/contracts/documents';
import { createApiTokenResponseSchema } from '../../src/shared/contracts/users';
import {
  receiptDetailSchema,
  uploadReceiptResponseSchema,
} from '../../src/shared/contracts/receipts';
import { splitDocumentResponseSchema } from '../../src/shared/contracts/files';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { expectData, expectError } from '../helpers/http';
import { onboardIdentity } from '../helpers/identity';

describe('Isolated service integrations and attribution (e2e)', () => {
  let app: TestApp;
  let cookie: string;
  let sequence = 0;
  beforeAll(async () => {
    app = await createTestApp({ uploadMaxBytes: 2048 });
  });
  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    app.emails.reset();
    app.files.clear();
    cookie = await onboardIdentity(app, `integrations${sequence++}@legere.local`);
  });
  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function integration(name = 'Rent Manage', ownerCookie = cookie) {
    const created = expectData(
      await api(app).post('/api/me/integrations', { name }).set('Cookie', ownerCookie).expect(201),
      integrationSchema,
    );
    return { ...created, ...(await issue(created.id, ownerCookie)) };
  }
  async function issue(id: string, ownerCookie = cookie) {
    return expectData(
      await api(app)
        .post(`/api/me/integrations/${id}/tokens`, { name: 'Production', expiresInDays: 90 })
        .set('Cookie', ownerCookie)
        .expect(201),
      integrationTokenResponseSchema,
    );
  }
  const upload = (token: string, text: string) =>
    request(app.baseUrl)
      .post('/api/integrations/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Legere-Filename', encodeURIComponent('Lease 2026.txt'))
      .type('application/octet-stream')
      .send(Buffer.from(text));
  const get = (token: string, path = '') =>
    request(app.baseUrl)
      .get(`/api/integrations/documents${path}`)
      .set('Authorization', `Bearer ${token}`);

  it('returns a stable document ID, persists attribution and exposes only its own bounded DTO', async () => {
    const service = await integration();
    const uploaded = expectData(
      await upload(service.token, 'A lease signed by both parties.').expect(201),
      integrationUploadResponseSchema,
    );
    expect(uploaded.created).toBe(true);
    expect(uploaded.document.createdVia).toEqual({
      kind: 'INTEGRATION',
      id: service.id,
      name: 'Rent Manage',
    });
    expect(uploaded.document.url).toBe(`http://localhost:3000/documents/${uploaded.document.id}`);
    const duplicate = expectData(
      await upload(service.token, 'A lease signed by both parties.').expect(201),
      integrationUploadResponseSchema,
    );
    expect(duplicate).toEqual({ ...uploaded, created: false });
    const detail = await get(service.token, `/${uploaded.document.id}`).expect(200);
    expect(expectData(detail, integrationDocumentSchema)).toEqual(uploaded.document);
    expect(
      Object.keys(z.object({ data: z.record(z.unknown()) }).parse(detail.body).data).sort(),
    ).toEqual(Object.keys(uploaded.document).sort());
    const browser = expectData(
      await api(app)
        .get(`/api/documents/${uploaded.document.id}`)
        .set('Cookie', cookie)
        .expect(200),
      documentDetailDtoSchema,
    );
    expect(browser.createdVia).toEqual(uploaded.document.createdVia);
    expect(browser.createdBy?.id).toBe(uploaded.document.ownerId);
    const log = expectData(
      await api(app)
        .get(`/api/documents/${uploaded.document.id}/events`)
        .set('Cookie', cookie)
        .expect(200),
      documentEventPageSchema,
    );
    expect(log.items.length).toBeGreaterThan(0);
    expect(
      log.items
        .filter((item) => item.actor !== null)
        .every((item) => item.actorAgent?.id === service.id),
    ).toBe(true);
    expect(
      expectData(
        await api(app).get('/api/me/integrations').set('Cookie', cookie),
        listIntegrationsSchema,
      ).items,
    ).toMatchObject([{ id: service.id, documentCount: 1 }]);
  });

  it('deduplicates concurrent uploads within one namespace', async () => {
    const service = await integration();
    const responses = await Promise.all([
      upload(service.token, 'Concurrent lease'),
      upload(service.token, 'Concurrent lease'),
    ]);
    const data = responses.map((response) => expectData(response, integrationUploadResponseSchema));
    expect(new Set(data.map((item) => item.document.id)).size).toBe(1);
    expect(data.filter((item) => item.created)).toHaveLength(1);
    expect(await testPrisma().document.count()).toBe(1);
  });

  it('isolates personal, other-service and other-user documents even for an administrator owner', async () => {
    const first = await integration();
    const second = await integration('Other service');
    const own = expectData(
      await upload(first.token, 'First service content'),
      integrationUploadResponseSchema,
    ).document;
    const other = expectData(
      await upload(second.token, 'Second service content'),
      integrationUploadResponseSchema,
    ).document;
    const personal = expectData(
      await api(app)
        .postBinary('/api/documents', Buffer.from('Personal content'))
        .set('Cookie', cookie)
        .set('X-Legere-Filename', 'personal.txt')
        .expect(201),
      uploadDocumentResponseSchema,
    ).document;
    const foreignCookie = await onboardIdentity(app, 'foreign-integration@legere.local', cookie);
    const foreignService = await integration('Rent Manage', foreignCookie);
    const foreign = expectData(
      await upload(foreignService.token, 'Foreign content'),
      integrationUploadResponseSchema,
    ).document;
    expect(
      expectData(await get(first.token).expect(200), integrationDocumentListSchema).items.map(
        (item) => item.id,
      ),
    ).toEqual([own.id]);
    for (const id of [other.id, personal.id, foreign.id, randomUUID()]) {
      for (const suffix of ['', '/canonical', '/preview'])
        await get(first.token, `/${id}${suffix}`).expect(404);
    }
    for (const content of ['Second service content', 'Personal content', 'Foreign content']) {
      const res = await upload(first.token, content).expect(409);
      expect(expectError(res).code).toBe('DOCUMENT_DUPLICATE');
      expect(res.text).not.toContain(other.id);
      expect(res.text).not.toContain(personal.id);
      expect(res.text).not.toContain(foreign.id);
    }
    for (const path of [
      '/api/documents',
      `/api/documents/${personal.id}`,
      '/api/search?q=content',
      '/api/receipts',
      '/api/me',
      '/api/me/integrations',
    ]) {
      await request(app.baseUrl)
        .get(path)
        .set('Authorization', `Bearer ${first.token}`)
        .expect(403);
    }
    await request(app.baseUrl)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(403);
    await get(first.token, `?integrationId=${second.id}`).expect(422);
    await get(first.token, '?limit=101').expect(422);
    await get(first.token, '/not-a-uuid').expect(404);
    await api(app)
      .get('/api/me/integrations')
      .set('Cookie', foreignCookie)
      .expect(200)
      .then((res) =>
        expect(expectData(res, listIntegrationsSchema).items.map((item) => item.id)).toEqual([
          foreignService.id,
        ]),
      );
  });

  it('paginates independently of documents in other namespaces', async () => {
    const first = await integration();
    const second = await integration('Another');
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push(
        expectData(await upload(first.token, `Owned ${index}`), integrationUploadResponseSchema)
          .document.id,
      );
      await upload(second.token, `Other ${index}`).expect(201);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: z.infer<typeof integrationDocumentListSchema> = expectData(
        await get(
          first.token,
          `?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        ).expect(200),
        integrationDocumentListSchema,
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null && seen.length < 5);
    expect(seen).toEqual(ids.reverse());
    expect(cursor).toBeNull();
  });

  it('issues scoped PDF and JPEG links after processing, with explicit expiry', async () => {
    const service = await integration();
    const document = expectData(
      await upload(service.token, 'Ready for preview'),
      integrationUploadResponseSchema,
    ).document;
    await get(service.token, `/${document.id}/canonical`).expect(409);
    await get(service.token, `/${document.id}/preview`).expect(409);
    await testPrisma().document.update({
      where: { id: document.id },
      data: { canonicalStatus: 'DONE', previewStatus: 'DONE' },
    });
    for (const kind of ['canonical', 'preview']) {
      const artifact = expectData(
        await get(service.token, `/${document.id}/${kind}`).expect(200),
        integrationArtifactSchema,
      );
      expect(artifact.contentType).toBe(kind === 'canonical' ? 'application/pdf' : 'image/jpeg');
      expect(artifact.url).toContain(
        `/documents/${document.id}/${kind === 'canonical' ? 'canonical.pdf' : 'preview.jpg'}`,
      );
      expect(new Date(artifact.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(new URL(artifact.url).searchParams.get('response-content-disposition')).toBe('inline');
    }
  });

  it('rotates tokens without changing document access and revokes the entire integration', async () => {
    const service = await integration();
    const id = expectData(
      await upload(service.token, 'Persistent document'),
      integrationUploadResponseSchema,
    ).document.id;
    const rotated = await issue(service.id);
    await api(app)
      .delete(`/api/me/api-tokens/${service.apiToken.id}`)
      .set('Cookie', cookie)
      .expect(200);
    await get(service.token).expect(401);
    await get(rotated.token, `/${id}`).expect(200);
    await api(app).delete(`/api/me/integrations/${service.id}`).set('Cookie', cookie).expect(200);
    await get(rotated.token).expect(401);
    await api(app)
      .post(`/api/me/integrations/${service.id}/tokens`, { name: 'Invalid resurrection' })
      .set('Cookie', cookie)
      .expect(403);
    const browser = expectData(
      await api(app).get(`/api/documents/${id}`).set('Cookie', cookie).expect(200),
      documentDetailDtoSchema,
    );
    expect(browser.createdVia?.name).toBe('Rent Manage');
    expect(
      (await testPrisma().archiveItem.findUniqueOrThrow({ where: { id } })).integrationId,
    ).toBe(service.id);
  });

  it('denies other owners, expired credentials, cookie access and ordinary tokens', async () => {
    const service = await integration();
    const otherCookie = await onboardIdentity(app, 'other-owner@legere.local', cookie);
    await api(app)
      .post(`/api/me/integrations/${service.id}/tokens`, { name: 'Stolen' })
      .set('Cookie', otherCookie)
      .expect(404);
    await api(app)
      .delete(`/api/me/integrations/${service.id}`)
      .set('Cookie', otherCookie)
      .expect(404);
    await request(app.baseUrl).get('/api/integrations/documents').set('Cookie', cookie).expect(401);
    await request(app.baseUrl).get('/api/integrations/documents').expect(401);
    for (const scope of ['READ', 'DOCUMENTS_INGEST', 'RECEIPTS_INGEST']) {
      const token = expectData(
        await api(app).post('/api/me/api-tokens', { name: scope, scope }).set('Cookie', cookie),
        createApiTokenResponseSchema,
      ).token;
      await get(token).expect(403);
      await upload(token, 'No privilege escalation').expect(403);
    }
    for (const scope of ['INTEGRATION', 'MCP'])
      await api(app)
        .post('/api/me/api-tokens', { name: 'Forged scope', scope })
        .set('Cookie', cookie)
        .expect(422);
    await testPrisma().apiToken.update({
      where: { id: service.apiToken.id },
      data: { expiresAt: new Date(0) },
    });
    await get(service.token).expect(401);
  });

  it('enforces raw upload size, filename and format validation', async () => {
    const service = await integration();
    await upload(service.token, 'x'.repeat(2049)).expect(413);
    await request(app.baseUrl)
      .post('/api/integrations/documents')
      .set('Authorization', `Bearer ${service.token}`)
      .type('application/octet-stream')
      .send(Buffer.from('body'))
      .expect(422);
    await request(app.baseUrl)
      .post('/api/integrations/documents')
      .set('Authorization', `Bearer ${service.token}`)
      .set('X-Legere-Filename', 'unknown.bin')
      .type('application/octet-stream')
      .send(Buffer.from([0, 1, 2, 3, 4]))
      .expect(415);
    expect(await testPrisma().document.count()).toBe(0);
  });

  it('blocks cross-namespace composition and preserves namespace and provenance when splitting', async () => {
    const service = await integration();
    const source = expectData(
      await upload(service.token, 'Source document'),
      integrationUploadResponseSchema,
    ).document;
    const other = expectData(
      await api(app)
        .postBinary('/api/documents', Buffer.from('Personal document'))
        .set('Cookie', cookie)
        .set('X-Legere-Filename', 'personal.txt'),
      uploadDocumentResponseSchema,
    ).document;
    await api(app)
      .post(`/api/documents/${source.id}/combine`, { documentIds: [other.id] })
      .set('Cookie', cookie)
      .expect(403);
    await api(app)
      .post(`/api/documents/${other.id}/combine`, { documentIds: [source.id] })
      .set('Cookie', cookie)
      .expect(403);
    await api(app)
      .postBinary(`/api/documents/${source.id}/files`, Buffer.from('Another page'))
      .set('Cookie', cookie)
      .set('X-Legere-Filename', 'page.txt')
      .expect(201);
    const pages = await testPrisma().documentPage.findMany({
      where: { documentId: source.id },
      orderBy: { position: 'asc' },
    });
    const pageId = pages[0]?.id;
    if (pageId === undefined) throw new Error('No page');
    await api(app)
      .post(`/api/documents/${source.id}/pages/move`, { documentId: other.id, pageIds: [pageId] })
      .set('Cookie', cookie)
      .expect(403);
    const split = expectData(
      await api(app)
        .post(`/api/documents/${source.id}/split`, { at: [1] })
        .set('Cookie', cookie)
        .expect(200),
      splitDocumentResponseSchema,
    );
    expect(split.splitDocumentIds).toHaveLength(1);
    for (const id of split.splitDocumentIds) {
      const part = expectData(
        await get(service.token, `/${id}`).expect(200),
        integrationDocumentSchema,
      );
      expect(part.createdVia).toEqual(source.createdVia);
      expect(part.ownerId).toBe(source.ownerId);
    }
  });

  it('retains immutable token attribution on documents and receipts after revocation and conversion', async () => {
    for (const kind of ['documents', 'receipts'] as const) {
      const issued = expectData(
        await api(app)
          .post('/api/me/api-tokens', {
            name: 'Codex token',
            scope: kind === 'documents' ? 'DOCUMENTS_INGEST' : 'RECEIPTS_INGEST',
          })
          .set('Cookie', cookie),
        createApiTokenResponseSchema,
      );
      let id: string;
      if (kind === 'documents') {
        const uploaded = expectData(
          await request(app.baseUrl)
            .post('/api/incoming/documents')
            .set('Authorization', `Bearer ${issued.token}`)
            .set('X-Legere-Filename', 'contract.txt')
            .type('application/octet-stream')
            .send(Buffer.from('Token-attributed document'))
            .expect(201),
          uploadDocumentResponseSchema,
        );
        id = uploaded.document.id;
      } else {
        const uploaded = expectData(
          await request(app.baseUrl)
            .post('/api/incoming/receipts')
            .set('Authorization', `Bearer ${issued.token}`)
            .attach('file', Buffer.from('%PDF-1.4\nReceipt\n%%EOF'), {
              filename: 'receipt.pdf',
              contentType: 'application/pdf',
            })
            .expect(201),
          uploadReceiptResponseSchema,
        );
        id = uploaded.receipt.id;
      }
      await api(app)
        .delete(`/api/me/api-tokens/${issued.apiToken.id}`)
        .set('Cookie', cookie)
        .expect(200);
      const res = await api(app).get(`/api/${kind}/${id}`).set('Cookie', cookie).expect(200);
      const identity =
        kind === 'documents'
          ? expectData(res, documentDetailDtoSchema).createdVia
          : expectData(res, receiptDetailSchema).createdVia;
      expect(identity).toEqual({ kind: 'API_TOKEN', id: issued.apiToken.id, name: 'Codex token' });
    }
    const service = await integration();
    const doc = expectData(
      await upload(service.token, '%PDF-1.4\nConverting document\n%%EOF'),
      integrationUploadResponseSchema,
    ).document;
    await testPrisma().document.update({
      where: { id: doc.id },
      data: {
        canonicalStatus: 'DONE',
        previewStatus: 'DONE',
        markdownStatus: 'DONE',
        analysisStatus: 'DONE',
        fieldsStatus: 'DONE',
        vectorizationStatus: 'DONE',
      },
    });
    await api(app)
      .patch(`/api/archive-items/${doc.id}/kind`, { kind: 'RECEIPT' })
      .set('Cookie', cookie)
      .expect(200);
    await get(service.token, `/${doc.id}`).expect(404);
    await testPrisma().receipt.update({
      where: { id: doc.id },
      data: { previewStatus: 'DONE', extractionStatus: 'DONE' },
    });
    await api(app)
      .patch(`/api/archive-items/${doc.id}/kind`, { kind: 'DOCUMENT' })
      .set('Cookie', cookie)
      .expect(200);
    expect(
      expectData(await get(service.token, `/${doc.id}`).expect(200), integrationDocumentSchema)
        .createdVia,
    ).toEqual(doc.createdVia);
  });

  it('publishes an unauthenticated OpenAPI 3.1 contract for all five service operations', async () => {
    const schema = z
      .object({
        openapi: z.literal('3.1.0'),
        paths: z.record(z.record(z.unknown())),
        components: z.object({ securitySchemes: z.record(z.unknown()) }),
      })
      .parse((await request(app.baseUrl).get('/api/openapi.json').expect(200)).body);
    expect(
      Object.keys(schema.paths).filter((path) => path.startsWith('/api/integrations/documents')),
    ).toEqual([
      '/api/integrations/documents',
      '/api/integrations/documents/{id}',
      '/api/integrations/documents/{id}/canonical',
      '/api/integrations/documents/{id}/preview',
    ]);
    expect(schema.components.securitySchemes).toHaveProperty('integrationToken');
  });
});
