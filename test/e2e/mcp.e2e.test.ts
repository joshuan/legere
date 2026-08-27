import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  createApiTokenResponseSchema,
  createInviteResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import { z } from 'zod';
import {
  cookieNamed,
  expectData,
  expectError,
  expectRpcError,
  expectRpcResult,
  expectTool,
} from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// What the handshake and the tool list look like on the wire (docs/07 §7.3a).
const initializeSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.unknown()),
  serverInfo: z.object({ name: z.string(), version: z.string() }),
});

const toolListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.object({ required: z.array(z.string()) }).passthrough(),
    }),
  ),
});

// MCP over one POST (docs/07 §7.3a, ADR-024): the archive as a tool set an assistant can be pointed
// at, under a read-only token that inherits its owner's access (docs/08 §8.2a).
describe('MCP (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let adminToken: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`mcpadmin${seq}@legere.local`);
    adminToken = await issue(adminCookie);
  });

  afterAll(async () => {
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

  async function inviteUser(email: string): Promise<string> {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', adminCookie);
    const token = expectData(created, createInviteResponseSchema).url.split('/').pop() ?? '';
    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('the invited user got no session');
    return sid;
  }

  async function issue(cookie: string): Promise<string> {
    const created = await api(app)
      .post('/api/me/api-tokens', { name: 'an assistant' })
      .set('Cookie', cookie)
      .expect(201);
    return expectData(created, createApiTokenResponseSchema).token;
  }

  async function givenLibrary(
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<string> {
    seq += 1;
    const library = await testPrisma().library.create({
      data: {
        name: `Library ${seq}`,
        rootPath: `/tmp/library-${seq}`,
        visibility,
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    return library.id;
  }

  // 🔒 No Origin header anywhere in this suite: an MCP client is not a browser and sends none, which
  // is exactly the case the origin check would refuse if this route were an ordinary mutation
  // (docs/08 §8.2a, §8.4).
  const rpc = (body: object, token: string | null = adminToken) => {
    const call = request(app.baseUrl).post('/api/mcp').send(body);
    return token === null ? call : call.set('Authorization', `Bearer ${token}`);
  };

  const call = (name: string, args: object, token: string | null = adminToken) =>
    rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token);

  describe('the handshake', () => {
    it('answers initialize with the version the client asked for and the tools it has', async () => {
      const res = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1' } },
      }).expect(200);

      const result = expectRpcResult(res, initializeSchema);
      expect(result.protocolVersion).toBe('2025-03-26');
      expect(result.capabilities).toEqual({ tools: {} });
      expect(result.serverInfo.name).toBe('legere');
    });

    it('answers its own version when the client asks for one it has never heard of', async () => {
      const res = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      }).expect(200);

      expect(expectRpcResult(res, initializeSchema).protocolVersion).toBe('2025-06-18');
    });

    it('answers a notification with nothing at all', async () => {
      const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }).expect(202);

      expect(res.text).toBe('');
    });

    it('lists exactly the three tools it has', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).expect(200);

      const { tools } = expectRpcResult(res, toolListSchema);
      expect(tools.map((tool) => tool.name)).toEqual([
        'search_documents',
        'get_document',
        'read_document',
      ]);
      // Each one carries the schema a client validates its arguments against.
      expect(tools[0]?.inputSchema.required).toEqual(['query']);
    });
  });

  describe('the tools', () => {
    it('searches the archive and says why each row is there', async () => {
      const libraryId = await givenLibrary();
      const seeded = await seedDocument({
        document: { title: 'Rental agreement', markdown: 'The tenant shall pay the deposit.' },
        libraryId,
      });

      const res = await call('search_documents', { query: 'deposit' }).expect(200);

      const answer = expectTool(res).json;
      expect(answer).toMatchObject({
        semanticAvailable: false,
        results: [
          {
            id: seeded.id,
            title: 'Rental agreement',
            matchedIn: ['text'],
          },
        ],
      });
      // 🔒 The markup is the browser's business; a model reads the sentence (docs/07 §7.3a).
      expect(JSON.stringify(answer)).not.toContain('<mark>');
      // And a row can be cited rather than described.
      expect(JSON.stringify(answer)).toContain(`/documents/${seeded.id}`);
    });

    it('tells what is known about one document', async () => {
      const libraryId = await givenLibrary();
      const seeded = await seedDocument({
        document: {
          title: 'Act of acceptance',
          markdown: 'Body text',
          description: 'The act that closes the contract.',
          country: 'ME',
          city: 'Podgorica',
        },
        libraryId,
      });

      const res = await call('get_document', { documentId: seeded.id }).expect(200);

      expect(expectTool(res).json).toMatchObject({
        id: seeded.id,
        title: 'Act of acceptance',
        description: 'The act that closes the contract.',
        place: 'Podgorica, ME',
        availability: 'AVAILABLE',
        textChars: 'Body text'.length,
      });
    });

    // 🔒 A forty-page scan is a quarter of a million characters and a context window is not.
    it('reads a long document in slices, and says where the next one starts', async () => {
      const libraryId = await givenLibrary();
      const seeded = await seedDocument({
        document: { title: 'Long one', markdown: 'abcdefghij'.repeat(10) },
        libraryId,
      });

      const first = await call('read_document', { documentId: seeded.id, limit: 40 }).expect(200);
      expect(expectTool(first).json).toMatchObject({ totalChars: 100, offset: 0, nextOffset: 40 });

      const rest = await call('read_document', {
        documentId: seeded.id,
        offset: 40,
        limit: 1000,
      }).expect(200);
      const answer = expectTool(rest).json;
      expect(answer).toMatchObject({ offset: 40, nextOffset: null });
      expect(JSON.stringify(answer)).toContain('abcdefghij');
    });

    it('answers a tool that cannot do its job with a sentence, not a transport error', async () => {
      const unknownId = '00000000-0000-4000-8000-000000000000';

      const res = await call('get_document', { documentId: unknownId }).expect(200);

      const answered = expectTool(res);
      expect(answered.isError).toBe(true);
      expect(answered.text).toContain('No such document');
    });

    it('refuses arguments that do not fit the tool', async () => {
      const res = await call('search_documents', { query: '' }).expect(200);

      expect(expectTool(res).isError).toBe(true);
    });

    it('has no tool but the three it listed', async () => {
      const res = await call('delete_document', { documentId: 'anything' }).expect(200);

      const answered = expectTool(res);
      expect(answered.isError).toBe(true);
      expect(answered.text).toContain('no tool called');
    });
  });

  describe('access', () => {
    // 🔒 An assistant reads the archive its owner reads, and nothing else (docs/08 §8.2a, §8.5).
    it('never answers with a document the token owner may not read', async () => {
      const secret = await givenLibrary('RESTRICTED');
      const hidden = await seedDocument({
        document: { title: 'Secret invoice', markdown: 'The invoice amount is due.' },
        libraryId: secret,
      });
      const userToken = await issue(await inviteUser(`mcpuser${seq}@legere.local`));

      const found = await call('search_documents', { query: 'invoice' }, userToken).expect(200);
      const fetched = await call('get_document', { documentId: hidden.id }, userToken).expect(200);
      const read = await call('read_document', { documentId: hidden.id }, userToken).expect(200);

      expect(expectTool(found).json).toMatchObject({ results: [] });
      // Not found and not allowed read alike: that the document exists is itself a disclosure.
      expect(expectTool(fetched).isError).toBe(true);
      expect(expectTool(read).isError).toBe(true);
      // And the admin, whose archive it is, sees it.
      const asAdmin = await call('get_document', { documentId: hidden.id }).expect(200);
      expect(expectTool(asAdmin).isError).toBe(false);
    });
  });

  describe('the credential', () => {
    it('refuses a caller with no token at all', async () => {
      await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null).expect(401);
    });

    it('refuses a token that is not one', async () => {
      await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'legere_nonsense').expect(401);
    });

    // 🔒 The route takes a bearer and nothing else, which is what leaves the origin check of §8.4
    // inapplicable rather than excepted: a browser holds no credential for this call.
    it('refuses a perfectly good session cookie', async () => {
      await request(app.baseUrl)
        .post('/api/mcp')
        .set('Cookie', adminCookie)
        .set('Origin', 'http://localhost:3000')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('refuses the cookie at every spelling the router resolves to this route', async () => {
      // 🔒 SEC-87: Express routes case-insensitively, so `/api/MCP` is this same controller — and
      // the no-cookie rule must hold there too, not only at the exact lowercase string.
      await request(app.baseUrl)
        .post('/api/MCP')
        .set('Cookie', adminCookie)
        .set('Origin', 'http://localhost:3000')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('keeps the origin check on the bare /mcp, which is not this route', async () => {
      // 🔒 SEC-88: the CSRF exemption covers the API path alone; the root-level `/mcp` belongs to
      // Next and a mutation there proves its origin like any other.
      await request(app.baseUrl)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(403);
    });

    // 🔒 And the hole is exactly this route: everything else a bearer might post is still refused
    // before it is looked up (docs/08 §8.2a).
    it('leaves every other POST closed to a token', async () => {
      const libraryId = await givenLibrary();
      const seeded = await seedDocument({ document: { title: 'Anything' }, libraryId });

      const reprocess = await request(app.baseUrl)
        .post(`/api/documents/${seeded.id}/reprocess`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Origin', 'http://localhost:3000')
        .send({});

      expect(reprocess.status).toBe(403);
      expect(expectError(reprocess).code).toBe('READ_ONLY_TOKEN');
    });
  });

  describe('the protocol itself', () => {
    it('refuses a body that is not a JSON-RPC request, echoing its id where it can', async () => {
      const res = await rpc({ id: 4, method: 'tools/list' }).expect(200);

      const failed = expectRpcError(res);
      expect(failed.code).toBe(-32600);
      expect(failed.id).toBe(4);
    });

    it('refuses a batch, which this protocol version does not have', async () => {
      const res = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]).expect(200);

      const failed = expectRpcError(res);
      expect(failed.code).toBe(-32600);
      expect(failed.id).toBeNull();
    });

    it('answers an unknown method with method-not-found', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' }).expect(200);

      expect(expectRpcError(res).code).toBe(-32601);
    });

    it('answers a tool call with no name with invalid-params', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }).expect(
        200,
      );

      expect(expectRpcError(res).code).toBe(-32602);
    });

    it('answers ping', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' }).expect(200);

      expect(expectRpcResult(res, z.object({}))).toEqual({});
    });
  });
});
