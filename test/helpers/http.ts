import type { Response } from 'supertest';
import { z, type ZodType } from 'zod';
import { errorBodySchema, type ErrorCode } from '../../src/shared/contracts/common';

// Typed access to API responses: the envelope is parsed with the contract schemas, so tests fail
// loudly on drift instead of reaching into an `any` body (docs/07 §7.1, docs/10 §10.5).

const successEnvelope = z.object({ data: z.unknown() });

export function expectData<T>(res: Response, schema: ZodType<T>): T {
  const envelope = successEnvelope.safeParse(res.body);
  if (!envelope.success) {
    throw new Error(
      `Expected a success envelope (status ${res.status}), got ${JSON.stringify(res.body)}`,
    );
  }
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw new Error(
      `Response data did not match the contract (status ${res.status}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export type ApiErrorBody = { code: ErrorCode; message: string; details: unknown };

export function expectError(res: Response): ApiErrorBody {
  const parsed = errorBodySchema.safeParse(res.body);
  if (!parsed.success) {
    throw new Error(
      `Expected an error envelope (status ${res.status}), got ${JSON.stringify(res.body)}`,
    );
  }
  const { code, message, details } = parsed.data.error;
  return { code, message, details: details ?? null };
}

// Set-Cookie is a string or an array depending on how many cookies were set.
export function cookiesOf(res: Response): string[] {
  const raw = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw;
  return typeof raw === 'string' ? [raw] : [];
}

export function cookieNamed(res: Response, name: string): string | undefined {
  return cookiesOf(res).find((cookie) => cookie.startsWith(`${name}=`));
}
