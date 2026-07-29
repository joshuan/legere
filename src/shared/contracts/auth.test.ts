import { describe, expect, it } from 'vitest';
import {
  emailCodeSchema,
  emailSchema,
  loginRequestSchema,
  passwordSchema,
  registerCompleteRequestSchema,
  registerStartRequestSchema,
  registerVerifyRequestSchema,
  userDtoSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './auth';

describe('emailSchema', () => {
  it('normalizes by trimming and lower-casing', () => {
    expect(emailSchema.parse('  Admin@Legere.Local ')).toBe('admin@legere.local');
  });

  it('rejects malformed addresses', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse('').success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('accepts a password within the length bounds', () => {
    expect(passwordSchema.safeParse('a-decent-passphrase').success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects passwords outside the length bounds', () => {
    expect(passwordSchema.safeParse('x'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('rejects denylisted passwords regardless of case', () => {
    expect(passwordSchema.safeParse('password').success).toBe(false);
    expect(passwordSchema.safeParse('PassWord123').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(false);
  });
});

describe('emailCodeSchema', () => {
  it('accepts exactly six digits', () => {
    expect(emailCodeSchema.parse(' 123456 ')).toBe('123456');
  });

  it('rejects anything else', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '12 34 56', '']) {
      expect(emailCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('auth request schemas', () => {
  it('accepts register/start with only an email and normalizes it', () => {
    const parsed = registerStartRequestSchema.parse({ email: 'USER@Legere.local' });
    expect(parsed).toEqual({ email: 'user@legere.local' });
  });

  it('accepts register/start with an invite token', () => {
    const parsed = registerStartRequestSchema.parse({
      email: 'user@legere.local',
      inviteToken: 'a'.repeat(32),
    });
    expect(parsed.inviteToken).toHaveLength(32);
  });

  it('validates register/verify and register/complete payloads', () => {
    expect(
      registerVerifyRequestSchema.safeParse({ email: 'user@legere.local', code: '000111' }).success,
    ).toBe(true);
    expect(
      registerCompleteRequestSchema.safeParse({
        ticket: 't'.repeat(32),
        password: 'a-decent-passphrase',
      }).success,
    ).toBe(true);
    // The password rule applies to registration completion, not to login.
    expect(
      registerCompleteRequestSchema.safeParse({ ticket: 't'.repeat(32), password: 'password' })
        .success,
    ).toBe(false);
  });

  it('does not apply the denylist to login (any existing password must be usable)', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'user@legere.local', password: 'password' }).success,
    ).toBe(true);
  });
});

describe('userDtoSchema', () => {
  it('parses a complete DTO', () => {
    const dto = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@legere.local',
      displayName: 'admin',
      role: 'ADMIN',
      language: 'EN',
      theme: 'SYSTEM',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(userDtoSchema.parse(dto)).toEqual(dto);
  });

  it('rejects a DTO carrying a password hash', () => {
    const result = userDtoSchema.strict().safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@legere.local',
      displayName: 'admin',
      role: 'ADMIN',
      language: 'EN',
      theme: 'SYSTEM',
      createdAt: '2026-01-01T00:00:00.000Z',
      passwordHash: '$argon2id$...',
    });
    expect(result.success).toBe(false);
  });
});
