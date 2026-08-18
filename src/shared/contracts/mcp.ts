import { z } from 'zod';
import { searchModeSchema } from './search';

// MCP over one POST (docs/07 §7.3a, ADR-024): JSON-RPC 2.0, four methods, three read-only tools.
// The envelope lives here with every other contract because it is what crosses the wire, and it is
// validated on the way in like everything else that does.

// The version of the protocol this server speaks. A client asking for another one is answered with
// this, and decides for itself whether it can live with the difference — which is what the
// specification asks of both sides.
export const MCP_PROTOCOL_VERSION = '2025-06-18';

// The versions this server is content to speak back, in the client's own words: the differences
// between them do not touch a server that has no sessions, no SSE and no resumability.
export const MCP_KNOWN_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

// JSON-RPC's own id: a string or a number, and absent on a notification (which is answered with
// nothing at all).
export const jsonRpcIdSchema = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcIdSchema.optional(),
  method: z.string().min(1),
  // Whatever the method takes; each one validates its own shape, because a wrong shape is
  // `-32602` and not a parse failure.
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

// The error codes of the specification, and the only ones this route answers with.
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

// --- what the tools take -------------------------------------------------------------------

// The archive answers by words and by meaning both (docs/07 §7.3); a limit small enough that an
// answer fits in a conversation and large enough to be worth reading.
export const searchDocumentsInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: searchModeSchema.optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputSchema>;

export const getDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
});
export type GetDocumentInput = z.infer<typeof getDocumentInputSchema>;

// 🔒 A forty-page scan is a quarter of a million characters and a context window is not, so the
// text is read in slices and the answer says where the next one starts (docs/07 §7.3a).
export const readDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
});
export type ReadDocumentInput = z.infer<typeof readDocumentInputSchema>;

export const MCP_READ_DOCUMENT_DEFAULT_LIMIT = 10_000;
