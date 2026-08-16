import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const headerStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve({ get: (name: string) => headerStore.get(name) ?? null }),
}));

// Vitest resolves `react` the way a browser does, and there `cache` is a pass-through by design: the
// memoizing implementation lives in the `react-server` build Next renders server components with.
// This stand-in is that build's contract — one answer per render pass, whoever asks — so the test
// can assert what this module does with it. A fresh module registry per test (below) is the pass.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
    let remembered: { value: Result } | null = null;
    return (...args: Args): Result => {
      remembered ??= { value: fn(...args) };
      return remembered.value;
    };
  },
}));

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@legere.local',
  displayName: 'admin',
  role: 'ADMIN',
  language: 'EN',
  theme: 'SYSTEM',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// One render pass per test: re-importing the module gives the memoization a clean slate, exactly as
// a new request does in the server.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  headerStore.clear();
  vi.unstubAllGlobals();
});

// The guard every authenticated page runs through (docs/10 §10.2).
describe('currentUser', () => {
  it('calls the API over loopback on the port this process listens on, not on the Host header', async () => {
    // The trap this replaced: inside a container the browser's `localhost:3000` is a published port
    // that nothing there answers, and every page rendered a 500.
    headerStore.set('host', 'localhost:3000');
    headerStore.set('cookie', 'sid=token');
    vi.stubEnv('PORT', '80');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: ADMIN }) });
    vi.stubGlobal('fetch', fetchMock);

    const { currentUser } = await import('./current-user.js');
    const user = await currentUser();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:80/api/me', expect.anything());
    // 🔒 The session travels with it, or the answer would always be "nobody".
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { cookie: 'sid=token' } });
    expect(user).toMatchObject({ role: 'ADMIN' });
  });

  it('is nobody when the API says no', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }),
    );

    const { currentUser } = await import('./current-user.js');

    expect(await currentUser()).toBeNull();
  });

  it('asks the API once a render pass, however many guards ask it', async () => {
    // What this replaced: the (app) layout asked, then the admin layout asked again a component
    // below it, and a page under both asked a third time — three loopback calls in sequence before
    // anything could be drawn (docs/10 §10.2).
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: ADMIN }) });
    vi.stubGlobal('fetch', fetchMock);

    const { currentUser } = await import('./current-user.js');
    const [layout, adminLayout] = await Promise.all([currentUser(), currentUser()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(adminLayout).toEqual(layout);
    expect(layout).toMatchObject({ role: 'ADMIN' });
  });

  it('is nobody when the answer does not match the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: 'nope' } }) }),
    );

    const { currentUser } = await import('./current-user.js');

    expect(await currentUser()).toBeNull();
  });
});
