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

// JSON-RPC, read the same way (docs/07 §7.3a): the MCP route answers outside the envelope above, so
// its two shapes are parsed here rather than reached into as `any` bodies.
const jsonRpcId = z.union([z.string(), z.number()]);

const rpcResultEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcId,
  result: z.unknown(),
});

const rpcErrorEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcId.nullable(),
  error: z.object({ code: z.number(), message: z.string() }),
});

// A tool's one JSON text block, and whether the tool considered itself to have failed.
const toolResult = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
  isError: z.boolean().optional(),
});

export function expectRpcResult<T>(res: Response, schema: ZodType<T>): T {
  const envelope = rpcResultEnvelope.safeParse(res.body);
  if (!envelope.success) {
    throw new Error(`Expected a JSON-RPC result, got ${JSON.stringify(res.body)}`);
  }
  const parsed = schema.safeParse(envelope.data.result);
  if (!parsed.success) {
    throw new Error(`The JSON-RPC result did not match: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function expectRpcError(res: Response): {
  code: number;
  message: string;
  id: string | number | null;
} {
  const parsed = rpcErrorEnvelope.safeParse(res.body);
  if (!parsed.success) {
    throw new Error(`Expected a JSON-RPC error, got ${JSON.stringify(res.body)}`);
  }
  return { ...parsed.data.error, id: parsed.data.id };
}

// What a tool answered: the JSON it wrote into its text block, and whether it failed. The text is
// parsed here because every tool of docs/07 §7.3a answers in exactly one JSON block.
export function expectTool(res: Response): { json: unknown; text: string; isError: boolean } {
  const result = expectRpcResult(res, toolResult);
  const text = result.content[0]?.text ?? '';
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { json, text, isError: result.isError === true };
}
