import { foldName } from '../../src/server/domain/value-objects/name-fold';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { searchResponseSchema } from '../../src/shared/contracts/search';
import {
  createApiTokenResponseSchema,
  createInviteResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, embeddingOf, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Search (docs/07 §7.3, docs/04 §4.3–4.4): words, meaning, and the fusion of the two.
describe('Search (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`searchadmin${seq}@legere.local`);
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

  async function inviteUser(email: string): Promise<{ id: string; cookie: string }> {
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
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return { id: expectData(completed, userDtoSchema).id, cookie };
  }

  let contentSeq = 0;

  async function givenLibrary(
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<string> {
    contentSeq += 1;
    const library = await testPrisma().library.create({
      data: {
        name: `Search ${contentSeq}`,
        rootPath: `search-${contentSeq}`,
        visibility,
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    return library.id;
  }

  // A searchable document: the tsvector is generated from title + markdown by the schema itself.
  async function givenDocument(
    libraryId: string,
    title: string,
    markdown: string | null,
    options: { typeId?: string; chunk?: number[] } = {},
  ): Promise<string> {
    contentSeq += 1;
    const document = await seedDocument({
      document: {
        title,
        markdown,
        canonicalStatus: 'SKIPPED',
        vectorizationStatus: 'DONE',
        ...(options.typeId === undefined ? {} : { typeId: options.typeId }),
      },
      libraryId,
      files: [{ path: `${title.toLowerCase().replace(/\s+/g, '-')}.pdf`, sizeBytes: 100n }],
    });

    if (options.chunk !== undefined) {
      const vector = `[${padded(options.chunk).join(',')}]`;
      await testPrisma().$executeRawUnsafe(
        `INSERT INTO document_chunks (id, document_id, index, content, char_count, embedding)
         VALUES (gen_random_uuid(), $1::uuid, 0, $2, $3, $4::vector)`,
        document.id,
        markdown ?? title,
        (markdown ?? title).length,
        vector,
      );
    }
    return document.id;
  }

  // The column's width is the schema's (docs/04 §4.3); fixtures name only the first components.
  function padded(head: number[]): number[] {
    return embeddingOf(head);
  }

  const search = (cookie: string, query: string) =>
    api(app).get(`/api/search${query}`).set('Cookie', cookie);

  describe('text mode', () => {
    it('finds a document by a word in its body, with the match highlighted', async () => {
      const libraryId = await givenLibrary();
      const documentId = await givenDocument(
        libraryId,
        'Rental agreement',
        'The tenant shall pay the deposit before occupancy.',
      );
      await givenDocument(libraryId, 'Unrelated', 'Nothing about that here.');

      const res = await search(adminCookie, '?q=deposit&mode=text');

      const results = expectData(res, searchResponseSchema);
      expect(results.items.map((hit) => hit.document.id)).toEqual([documentId]);
      // ts_headline marks the words that matched (docs/07 §7.3).
      expect(results.items[0]?.snippet).toContain('<mark>deposit</mark>');
    });

    it('finds a document by its title alone', async () => {
      const libraryId = await givenLibrary();
      const documentId = await givenDocument(libraryId, 'Passport scan', null);

      const res = await search(adminCookie, '?q=passport&mode=text');

      expect(expectData(res, searchResponseSchema).items.map((hit) => hit.document.id)).toEqual([
        documentId,
      ]);
    });

    // A number is findable in the alphabet it is typed in, not the one it was printed in (docs/04
    // §4.3). Twelve Cyrillic capitals are drawn exactly like Latin ones, OCR keeps whichever the
    // glyph came from, and nobody typing a VIN off their own registration knows which they got.
    it('finds a number typed in either alphabet, whichever one it was scanned in', async () => {
      const libraryId = await givenLibrary();
      // The VIN as OCR read it off a Russian registration: Х, Т, А and М are Cyrillic here.
      const russian = await givenDocument(
        libraryId,
        'Registration',
        'Идентификационный номер ХТА210700М0596136, двигатель 2103.',
      );
      // The same shape of number on a paper printed in Latin.
      const serbian = await givenDocument(
        libraryId,
        'Saobracajna',
        'Broj sasije XTA210700M0596136',
      );

      const inLatin = await search(adminCookie, '?q=XTA210700M0596136&mode=text');
      const inCyrillic = await search(
        adminCookie,
        `?q=${encodeURIComponent('ХТА210700М0596136')}&mode=text`,
      );

      expect(
        expectData(inLatin, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([russian, serbian].sort());
      expect(
        expectData(inCyrillic, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([russian, serbian].sort());
    });

    // Ј (U+0408) is an everyday letter of the Serbian alphabet and is drawn exactly like a Latin J,
    // so an OCR pass over a Serbian Cyrillic paper puts it inside numbers printed in Latin.
    it('finds a Serbian paper through the letter its alphabet shares with Latin', async () => {
      const libraryId = await givenLibrary();
      const polis = await givenDocument(
        libraryId,
        'Polisa',
        'Полиса осигурања ЈМ2025 од аутоодговорности.',
      );
      await givenDocument(libraryId, 'Other', 'Nothing quotable here.');

      const res = await search(adminCookie, '?q=JM2025&mode=text');

      expect(expectData(res, searchResponseSchema).items.map((hit) => hit.document.id)).toEqual([
        polis,
      ]);
    });

    // A mark is not a look-alike: `č` and `c` are different letters that look different, and whether
    // a paper carries the mark depends on who typed it (docs/04 §4.3). One archive holds the same
    // Belgrade street both ways — a parts-shop invoice without the marks, a utility bill with them.
    it('finds a word whether or not the paper kept its diacritics, both ways round', async () => {
      const libraryId = await givenLibrary();
      const marked = await givenDocument(
        libraryId,
        'Racun za komunalije',
        'Stanislava Sremčevića 20/1, Beograd.',
      );
      const plain = await givenDocument(
        libraryId,
        'Otpremnica',
        'STANISLAVA SREMCEVICA 020A, 11000 BEOGRAD',
      );

      const plainQuery = await search(adminCookie, '?q=Sremcevica&mode=text');
      const markedQuery = await search(
        adminCookie,
        `?q=${encodeURIComponent('Sremčevića')}&mode=text`,
      );

      expect(
        expectData(plainQuery, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([marked, plain].sort());
      expect(
        expectData(markedQuery, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([marked, plain].sort());
    });

    it('keeps the highlight on the words as the paper spells them', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(libraryId, 'Racun', 'Ulica Sremčevića broj 20.');

      const res = await search(adminCookie, `?q=${encodeURIComponent('Sremčevića')}&mode=text`);

      // The first branch of the query is the words as typed, so what is marked is the word the
      // document actually carries — folding the query outright would have cost this (docs/04 §4.3).
      expect(expectData(res, searchResponseSchema).items[0]?.snippet).toContain(
        '<mark>Sremčevića</mark>',
      );
    });

    // One person, filed twice: Шершнев Евгений on every Russian paper and SHERSHNEV EVGENII on every
    // Serbian one (docs/04 §4.3). Б looks nothing like B, so no fold of glyphs joins them — this is
    // a mapping between alphabets, and it has to work from either side.
    it('reads a name out of Cyrillic into Latin, and finds it from either side', async () => {
      const libraryId = await givenLibrary();
      const russian = await givenDocument(
        libraryId,
        'Trudovaya',
        'Сведения о трудовой деятельности, Шершнев Евгений Константинович, Екатеринбург.',
      );
      const serbian = await givenDocument(
        libraryId,
        'Saobracajna',
        'SHERSHNEV EVGENII, BEOGRAD, Stanislava Sremcevica 20A.',
      );

      const latinQuery = await search(adminCookie, '?q=Shershnev&mode=text');
      const cyrillicQuery = await search(
        adminCookie,
        `?q=${encodeURIComponent('Шершнев')}&mode=text`,
      );

      expect(
        expectData(latinQuery, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([russian, serbian].sort());
      expect(
        expectData(cyrillicQuery, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([russian, serbian].sort());
    });

    it('finds a Serbian city written in either alphabet', async () => {
      const libraryId = await givenLibrary();
      const cyrillic = await givenDocument(libraryId, 'Polisa', 'Издато у граду Београд.');
      const latin = await givenDocument(libraryId, 'Racun', 'Izdato u gradu Beograd.');

      const res = await search(adminCookie, '?q=Beograd&mode=text');

      expect(
        expectData(res, searchResponseSchema)
          .items.map((hit) => hit.document.id)
          .sort(),
      ).toEqual([cyrillic, latin].sort());
    });

    // 🔒 Short Cyrillic words are the function words of both languages and read out as na, on, no,
    // god, sam, dom — words a Latin query uses. The configuration is `simple` and has no stop words,
    // so folding them lets a search for `god` answer with every dated Russian paper there is. Four
    // characters is the floor; three was not enough (docs/04 §4.3).
    it('does not read short Cyrillic words out into Latin words', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(
        libraryId,
        'Dogovor',
        'Договор подписан на дом, но не сегодня. Квитанция за Июль 2026 год.',
      );
      await givenDocument(libraryId, 'Ugovor', 'Ја сам потписао уговор.');

      for (const word of ['na', 'no', 'god', 'sam', 'dom']) {
        const res = await search(adminCookie, `?q=${word}&mode=text`);
        expect(expectData(res, searchResponseSchema).items, word).toEqual([]);
      }
    });

    // 🔒 A fold carries no highlight, and that is worth pinning: ts_headline marks the query against
    // the text as written, so a paper reached only through a twin comes back with a snippet and no
    // mark in it (docs/04 §4.3). The row is the answer; the mark is not always available.
    it('answers without a highlight when only the fold matched', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(libraryId, 'Racun', 'Ulica Sremčevića broj 20.');

      const res = await search(adminCookie, '?q=Sremcevica&mode=text');

      const hit = expectData(res, searchResponseSchema).items[0];
      expect(hit).toBeDefined();
      expect(hit?.snippet).not.toContain('<mark>');
    });

    it('leaves words alone, so a Latin one can never match a Russian one', async () => {
      const libraryId = await givenLibrary();
      // Every letter of Москва has a Latin look-alike; a fold applied to words would make this
      // document answer to Mockba, and every Russian word answer to something.
      await givenDocument(libraryId, 'Place', 'Договор подписан в городе Москва.');

      const res = await search(adminCookie, '?q=Mockba&mode=text');

      expect(expectData(res, searchResponseSchema).items).toEqual([]);
    });

    it('returns nothing for an empty query rather than everything', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(libraryId, 'Something', 'Body');

      const res = await search(adminCookie, '?q=');

      expect(expectData(res, searchResponseSchema).items).toEqual([]);
    });
  });

  // Everything the document has a word in (docs/04 §4.3, docs/07 §7.3): its own columns, and the
  // names of what it is made of and about — which is what a person actually remembers about a scan.
  describe('every field the document has', () => {
    it('finds a document by the name of the file it is made of, and says so', async () => {
      const libraryId = await givenLibrary();
      const document = await seedDocument({
        document: { title: 'Untitled scan', markdown: 'Nothing quotable in the body.' },
        libraryId,
        files: [{ name: 'IMG_0042.jpg', path: 'phone/IMG_0042.jpg', sizeBytes: 100n }],
      });
      await givenDocument(libraryId, 'Another paper', 'Nothing quotable in the body.');

      const res = await search(adminCookie, '?q=IMG_0042&mode=text');

      const results = expectData(res, searchResponseSchema);
      expect(results.items.map((hit) => hit.document.id)).toEqual([document.id]);
      // Why the row is here, said out loud (docs/11 §11.6) — and quoted, because the headline is cut
      // from the names as well as from the prose.
      expect(results.items[0]?.matchedIn).toEqual(['fileName']);
      expect(results.items[0]?.snippet).toContain('<mark>');
    });

    it('ranks a file-name hit with the titles rather than under the archive', async () => {
      const libraryId = await givenLibrary();
      const byName = await seedDocument({
        document: { title: 'Untitled scan', markdown: null },
        libraryId,
        files: [{ name: 'kadastar.pdf', path: 'scans/kadastar.pdf', sizeBytes: 100n }],
      });
      // A document that only mentions the word in passing, deep in its text.
      await givenDocument(libraryId, 'Long report', `Preamble. ${'filler '.repeat(200)} kadastar.`);

      const res = await search(adminCookie, '?q=kadastar&mode=text');

      expect(expectData(res, searchResponseSchema).items[0]?.document.id).toBe(byName.id);
    });

    it('finds a document by a name it is about, the moment that name changes', async () => {
      const libraryId = await givenLibrary();
      const person = await testPrisma().person.create({
        data: { name: 'Marija Petrovic', nameFolded: foldName('Marija Petrovic') },
      });
      const document = await givenDocument(libraryId, 'Untitled', 'Nothing about anybody.');
      await testPrisma().documentPerson.create({
        data: { documentId: document, personId: person.id },
      });

      const found = expectData(
        await search(adminCookie, '?q=Petrovic&mode=text'),
        searchResponseSchema,
      );
      expect(found.items.map((hit) => hit.document.id)).toEqual([document]);
      expect(found.items[0]?.matchedIn).toEqual(['person']);

      // 🔒 Nothing is copied onto the document, so a rename is searchable at once and the old name
      // stops answering — a projection would have left both wrong until something rewrote it
      // (docs/04 §4.3).
      await testPrisma().person.update({
        where: { id: person.id },
        data: { name: 'Marija Kovac' },
      });

      const renamed = expectData(
        await search(adminCookie, '?q=Kovac&mode=text'),
        searchResponseSchema,
      );
      expect(renamed.items.map((hit) => hit.document.id)).toEqual([document]);
      expect(
        expectData(await search(adminCookie, '?q=Petrovic&mode=text'), searchResponseSchema).items,
      ).toEqual([]);
    });

    it('finds a document by the thing it is about', async () => {
      const libraryId = await givenLibrary();
      const kind = await testPrisma().subjectKind.create({
        data: { name: 'apartment', nameFolded: foldName('apartment') },
      });
      const subject = await testPrisma().subject.create({
        data: { kindId: kind.id, name: 'Njegoseva 5', nameFolded: foldName('Njegoseva 5') },
      });
      const document = await givenDocument(libraryId, 'Untitled', 'Nothing about anything.');
      await testPrisma().documentSubject.create({
        data: { documentId: document, subjectId: subject.id },
      });

      const res = await search(adminCookie, '?q=Njegoseva&mode=text');

      const results = expectData(res, searchResponseSchema);
      expect(results.items.map((hit) => hit.document.id)).toEqual([document]);
      expect(results.items[0]?.matchedIn).toEqual(['subject']);
    });

    it('finds a document by its description and by its place', async () => {
      const libraryId = await givenLibrary();
      const described = await seedDocument({
        document: {
          title: 'Untitled one',
          markdown: null,
          description: 'A statement of the water meter readings.',
        },
        libraryId,
      });
      const placed = await seedDocument({
        document: { title: 'Untitled two', markdown: null, country: 'ME', city: 'Podgorica' },
        libraryId,
      });

      const byDescription = expectData(
        await search(adminCookie, '?q=meter&mode=text'),
        searchResponseSchema,
      );
      const byPlace = expectData(
        await search(adminCookie, '?q=Podgorica&mode=text'),
        searchResponseSchema,
      );

      expect(byDescription.items.map((hit) => hit.document.id)).toEqual([described.id]);
      expect(byDescription.items[0]?.matchedIn).toEqual(['description']);
      expect(byPlace.items.map((hit) => hit.document.id)).toEqual([placed.id]);
      expect(byPlace.items[0]?.matchedIn).toEqual(['place']);
    });

    it('names every part that matched, not only the first', async () => {
      const libraryId = await givenLibrary();
      const document = await seedDocument({
        document: { title: 'Deposit receipt', markdown: 'The deposit was paid in full.' },
        libraryId,
        files: [{ name: 'deposit.pdf', path: 'bank/deposit.pdf', sizeBytes: 100n }],
      });

      const res = await search(adminCookie, '?q=deposit&mode=text');

      const hit = expectData(res, searchResponseSchema).items.find(
        (item) => item.document.id === document.id,
      );
      expect(hit?.matchedIn).toEqual(['title', 'fileName', 'text']);
    });

    // 🔒 A name matching inside a document the caller may not read is not a row (docs/07 §7.3): the
    // access rule is in the same query, before the limit.
    it('never surfaces a document through a name the caller may not read', async () => {
      const secret = await givenLibrary('RESTRICTED');
      await seedDocument({
        document: { title: 'Untitled', markdown: null },
        libraryId: secret,
        files: [{ name: 'kadastar.pdf', path: 'secret/kadastar.pdf', sizeBytes: 100n }],
      });
      const user = await inviteUser(`searchnames${seq}@legere.local`);

      const res = await search(user.cookie, '?q=kadastar&mode=text');

      expect(expectData(res, searchResponseSchema).items).toEqual([]);
    });
  });

  describe('access', () => {
    it('never surfaces a document from a library the caller cannot see', async () => {
      const open = await givenLibrary('ALL_USERS');
      const secret = await givenLibrary('RESTRICTED');
      const visible = await givenDocument(open, 'Public invoice', 'The invoice amount is due.');
      await givenDocument(secret, 'Secret invoice', 'The invoice amount is due.');
      const user = await inviteUser(`searchuser${seq}@legere.local`);

      const asUser = expectData(await search(user.cookie, '?q=invoice'), searchResponseSchema);
      const asAdmin = expectData(await search(adminCookie, '?q=invoice'), searchResponseSchema);

      // 🔒 The access rule is inside the query, so the limit applies to readable rows only.
      expect(asUser.items.map((hit) => hit.document.id)).toEqual([visible]);
      expect(asAdmin.items).toHaveLength(2);
    });
  });

  describe('filters', () => {
    it('narrows by library and by documentType', async () => {
      const one = await givenLibrary();
      const two = await givenLibrary();
      const documentType = await testPrisma().documentType.create({
        data: { slug: 'invoice', name: 'Invoice' },
      });
      const inOne = await givenDocument(one, 'Invoice one', 'payment terms apply', {
        typeId: documentType.id,
      });
      await givenDocument(two, 'Invoice two', 'payment terms apply');

      const byLibrary = expectData(
        await search(adminCookie, `?q=payment&libraryId=${one}`),
        searchResponseSchema,
      );
      const byCategory = expectData(
        await search(adminCookie, `?q=payment&typeId=${documentType.id}`),
        searchResponseSchema,
      );

      expect(byLibrary.items.map((hit) => hit.document.id)).toEqual([inOne]);
      expect(byCategory.items.map((hit) => hit.document.id)).toEqual([inOne]);
    });
  });

  describe('semantic and hybrid', () => {
    it('reports semantic search as unavailable and falls back to text', async () => {
      const libraryId = await givenLibrary();
      const documentId = await givenDocument(libraryId, 'Contract', 'the parties agree');

      const hybrid = expectData(await search(adminCookie, '?q=parties'), searchResponseSchema);
      const semantic = expectData(
        await search(adminCookie, '?q=parties&mode=semantic'),
        searchResponseSchema,
      );

      // No EMBEDDINGS_API_BASE_URL in the test environment (docs/12 §12.4).
      expect(hybrid.semanticAvailable).toBe(false);
      expect(hybrid.items.map((hit) => hit.document.id)).toEqual([documentId]);
      // Asking for semantic explicitly still answers with what the instance can do.
      expect(semantic.items.map((hit) => hit.document.id)).toEqual([documentId]);
    });

    it('orders the same query the same way every time', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(libraryId, 'Invoice A', 'shared word here');
      await givenDocument(libraryId, 'Invoice B', 'shared word here');

      const first = expectData(await search(adminCookie, '?q=shared'), searchResponseSchema);
      const second = expectData(await search(adminCookie, '?q=shared'), searchResponseSchema);

      expect(first.items.map((hit) => hit.document.id)).toEqual(
        second.items.map((hit) => hit.document.id),
      );
    });
  });

  it('refuses an anonymous caller', async () => {
    expect((await api(app).get('/api/search?q=anything')).status).toBe(401);
  });

  // 🔒 SEC-74: search is the one read a signed-in caller can repeat at will, and every non-text one
  // spends an outbound embeddings call on the operator's provider and a turn at the pipeline's own
  // embeddings gate. The budget is counted against the caller, not their address (docs/08 §8.4).
  describe('the search budget', () => {
    // Sessions live in the database, so a cookie minted through the suite's app authenticates just
    // as well against a second one raised over it — which is how these two get a signed-in caller
    // without onboarding twice.
    it('refuses one caller past their budget and leaves everybody else searching', async () => {
      const other = await inviteUser(`budgetuser${seq}@legere.local`);
      const throttled = await createTestApp({ searchThrottle: { ttl: 60_000, limit: 2 } });
      try {
        for (let query = 1; query <= 2; query += 1) {
          await api(throttled).get('/api/search?q=anything').set('Cookie', adminCookie).expect(200);
        }
        const refused = await api(throttled)
          .get('/api/search?q=anything')
          .set('Cookie', adminCookie)
          .expect(429);
        expect(expectError(refused).code).toBe('RATE_LIMITED');

        // The second account arrives from the same address and has a budget of its own.
        await api(throttled).get('/api/search?q=anything').set('Cookie', other.cookie).expect(200);
      } finally {
        await throttled.close();
      }
    });

    // The MCP tool is the same search under another protocol, so it draws on the same budget
    // (docs/07 §7.3a) — and a 429 there is an HTTP failure, not a JSON-RPC one.
    it('is shared with the MCP route the assistant searches through', async () => {
      const created = await api(app)
        .post('/api/me/api-tokens', { name: 'an assistant' })
        .set('Cookie', adminCookie)
        .expect(201);
      const token = expectData(created, createApiTokenResponseSchema).token;

      const throttled = await createTestApp({ searchThrottle: { ttl: 60_000, limit: 2 } });
      try {
        await api(throttled).get('/api/search?q=anything').set('Cookie', adminCookie).expect(200);
        await api(throttled)
          .post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        const refused = await api(throttled)
          .post('/api/mcp', {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'search_documents', arguments: { query: 'anything' } },
          })
          .set('Authorization', `Bearer ${token}`)
          .expect(429);
        expect(expectError(refused).code).toBe('RATE_LIMITED');
      } finally {
        await throttled.close();
      }
    });
  });
});
