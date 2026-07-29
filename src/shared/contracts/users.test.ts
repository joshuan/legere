import { describe, expect, it } from 'vitest';
import {
  createInviteRequestSchema,
  listUsersQuerySchema,
  updateMeRequestSchema,
  updateUserRequestSchema,
  userLookupResponseSchema,
} from './users';

describe('updateMeRequestSchema', () => {
  it('accepts a partial update', () => {
    expect(updateMeRequestSchema.parse({ language: 'RU' })).toEqual({ language: 'RU' });
    expect(updateMeRequestSchema.parse({ displayName: ' Ann ' })).toEqual({ displayName: 'Ann' });
  });

  it('rejects an empty patch and unknown enum values', () => {
    expect(updateMeRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ theme: 'NEON' }).success).toBe(false);
  });
});

describe('updateUserRequestSchema', () => {
  it('accepts a role change and rejects an empty patch', () => {
    expect(updateUserRequestSchema.parse({ role: 'ADMIN' })).toEqual({ role: 'ADMIN' });
    expect(updateUserRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('listUsersQuerySchema', () => {
  it('applies the default limit and coerces numeric strings', () => {
    expect(listUsersQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(listUsersQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('enforces the maximum page size', () => {
    expect(listUsersQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('createInviteRequestSchema', () => {
  it('requires a role and normalizes the optional email hint', () => {
    expect(
      createInviteRequestSchema.parse({ role: 'USER', emailHint: ' New@Legere.Local ' }),
    ).toEqual({ role: 'USER', emailHint: 'new@legere.local' });
    expect(createInviteRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('userLookupResponseSchema', () => {
  it('caps the directory response at ten users', () => {
    const item = {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'user',
      email: 'user@legere.local',
    };
    expect(userLookupResponseSchema.safeParse(Array.from({ length: 10 }, () => item)).success).toBe(
      true,
    );
    expect(userLookupResponseSchema.safeParse(Array.from({ length: 11 }, () => item)).success).toBe(
      false,
    );
  });
});
