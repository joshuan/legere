import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeSessionTokens,
  FixedClock,
  InMemoryUserRepository,
  RecordingSecurityEvents,
} from '../../../../test/helpers/fakes';
import {
  ApiTokenRepository,
  type ApiToken,
  type CreateApiTokenInput,
} from '../../domain/repositories/api-token.repository';
import { ForbiddenError, UnauthenticatedError } from '../../domain/errors/domain-error';
import { CreateApiToken, ListApiTokens, RevokeApiToken } from '../users/manage-api-tokens';
import { API_TOKEN_PREFIX, AuthenticateApiToken } from './authenticate-api-token';

class InMemoryApiTokenRepository extends ApiTokenRepository {
  readonly tokens: ApiToken[] = [];
  private counter = 0;

  constructor(private readonly clock: FixedClock) {
    super();
  }

  create(input: CreateApiTokenInput): Promise<ApiToken> {
    this.counter += 1;
    const token: ApiToken = {
      id: `api-token-${this.counter}`,
      userId: input.userId,
      name: input.name,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: this.clock.now(),
    };
    this.tokens.push(token);
    return Promise.resolve(token);
  }

  findByTokenHash(tokenHash: string): Promise<ApiToken | null> {
    return Promise.resolve(this.tokens.find((token) => token.tokenHash === tokenHash) ?? null);
  }

  findById(id: string): Promise<ApiToken | null> {
    return Promise.resolve(this.tokens.find((token) => token.id === id) ?? null);
  }

  listForUser(userId: string): Promise<ApiToken[]> {
    return Promise.resolve(this.tokens.filter((token) => token.userId === userId).reverse());
  }

  revoke(id: string, revokedAt: Date): Promise<void> {
    const token = this.tokens.find((candidate) => candidate.id === id);
    if (token !== undefined) token.revokedAt = revokedAt;
    return Promise.resolve();
  }

  revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    const live = this.tokens.filter((token) => token.userId === userId && token.revokedAt === null);
    live.forEach((token) => (token.revokedAt = revokedAt));
    return Promise.resolve(live.length);
  }

  touch(id: string, lastUsedAt: Date): Promise<void> {
    const token = this.tokens.find((candidate) => candidate.id === id);
    if (token !== undefined) token.lastUsedAt = lastUsedAt;
    return Promise.resolve();
  }
}

// Read-only API tokens (docs/08 §8.2a).
describe('API tokens', () => {
  let clock: FixedClock;
  let apiTokens: InMemoryApiTokenRepository;
  let users: InMemoryUserRepository;
  let tokens: FakeSessionTokens;
  let create: CreateApiToken;
  let events: RecordingSecurityEvents;
  let authenticate: AuthenticateApiToken;
  let userId: string;

  beforeEach(async () => {
    clock = new FixedClock();
    apiTokens = new InMemoryApiTokenRepository(clock);
    users = new InMemoryUserRepository(clock);
    tokens = new FakeSessionTokens();
    events = new RecordingSecurityEvents();
    create = new CreateApiToken(apiTokens, tokens, clock, 90, events);
    authenticate = new AuthenticateApiToken(apiTokens, users, tokens, clock);

    const user = await users.create({
      email: 'owner@legere.local',
      passwordHash: 'hash',
      displayName: 'Owner',
      role: 'USER',
      language: 'EN',
    });
    userId = user.id;
  });

  it('issues a prefixed token, stores only its hash, and answers with the owner', async () => {
    const created = await create.execute(userId, { name: 'export script' });

    expect(created.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    // What is stored is the hash of the whole presented string, prefix included — never the string.
    expect(apiTokens.tokens[0]?.tokenHash).not.toBe(created.token);
    expect(apiTokens.tokens.map((token) => token.tokenHash)).toEqual([tokens.hash(created.token)]);

    const caller = await authenticate.execute(created.token);
    expect(caller.kind).toBe('API_TOKEN');
    expect(caller.user.id).toBe(userId);
  });

  it('defaults the lifetime to the instance setting and honours a chosen one', async () => {
    const day = 24 * 60 * 60 * 1000;
    const byDefault = await create.execute(userId, { name: 'default' });
    const chosen = await create.execute(userId, { name: 'a week', expiresInDays: 7 });

    expect(Date.parse(byDefault.apiToken.expiresAt) - clock.now().getTime()).toBe(90 * day);
    expect(Date.parse(chosen.apiToken.expiresAt) - clock.now().getTime()).toBe(7 * day);
  });

  it('refuses a token that is unknown, malformed, expired or revoked', async () => {
    const created = await create.execute(userId, { name: 'export script', expiresInDays: 1 });

    await expect(authenticate.execute(undefined)).rejects.toBeInstanceOf(UnauthenticatedError);
    // A string without the prefix is not one of ours and is not worth a lookup.
    await expect(authenticate.execute('token-1')).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(authenticate.execute(`${API_TOKEN_PREFIX}nope`)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );

    clock.advance(2 * 24 * 60 * 60 * 1000);
    await expect(authenticate.execute(created.token)).rejects.toBeInstanceOf(UnauthenticatedError);

    clock.advance(-2 * 24 * 60 * 60 * 1000);
    await new RevokeApiToken(apiTokens, clock, events).execute(userId, created.apiToken.id);
    await expect(authenticate.execute(created.token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('refuses a token whose owner was deactivated', async () => {
    const created = await create.execute(userId, { name: 'export script' });
    await users.update(userId, { deactivatedAt: clock.now() });

    await expect(authenticate.execute(created.token)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('stamps last use at most once a minute', async () => {
    const created = await create.execute(userId, { name: 'export script' });

    await authenticate.execute(created.token);
    const firstUse = apiTokens.tokens[0]?.lastUsedAt;
    expect(firstUse).toEqual(clock.now());

    clock.advance(30_000);
    await authenticate.execute(created.token);
    expect(apiTokens.tokens[0]?.lastUsedAt).toEqual(firstUse);

    clock.advance(31_000);
    await authenticate.execute(created.token);
    expect(apiTokens.tokens[0]?.lastUsedAt).toEqual(clock.now());
  });

  it('lists a user own tokens with a status derived at read time', async () => {
    const list = new ListApiTokens(apiTokens, clock);
    const shortLived = await create.execute(userId, { name: 'a day', expiresInDays: 1 });
    const revoked = await create.execute(userId, { name: 'revoked' });
    await new RevokeApiToken(apiTokens, clock, events).execute(userId, revoked.apiToken.id);

    clock.advance(2 * 24 * 60 * 60 * 1000);
    const items = (await list.execute(userId)).items;

    expect(items.find((item) => item.id === shortLived.apiToken.id)?.status).toBe('EXPIRED');
    // Revocation is a decision somebody made; it outranks having also expired.
    expect(items.find((item) => item.id === revoked.apiToken.id)?.status).toBe('REVOKED');
  });

  it('will not let one user revoke another user token', async () => {
    const created = await create.execute(userId, { name: 'export script' });
    const stranger = await users.create({
      email: 'stranger@legere.local',
      passwordHash: 'hash',
      displayName: 'Stranger',
      role: 'ADMIN',
      language: 'EN',
    });

    await expect(
      new RevokeApiToken(apiTokens, clock, events).execute(stranger.id, created.apiToken.id),
    ).rejects.toMatchObject({ code: 'API_TOKEN_NOT_FOUND' });
  });

  // 🔒 SEC-34 (docs/06 §6.7). A token is a credential; both ends of its life are account history.
  it('records a token issued and revoked without ever recording the token', async () => {
    const created = await create.execute(userId, { name: 'export script' });
    await new RevokeApiToken(apiTokens, clock, events).execute(userId, created.apiToken.id);

    expect(events.names()).toEqual(['api_token.created', 'api_token.revoked']);
    expect(events.only('api_token.created')).toEqual({
      event: 'api_token.created',
      actor: { userId },
      target: { userId, id: created.apiToken.id },
    });
    expect(JSON.stringify(events.records)).not.toContain(created.token);
    // Revoking twice is not an event twice: the second call changes nothing.
    await new RevokeApiToken(apiTokens, clock, events).execute(userId, created.apiToken.id);
    expect(events.names()).toHaveLength(2);
  });
});
