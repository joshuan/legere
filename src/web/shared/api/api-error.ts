import type { ErrorCode } from '../../../shared/contracts/common';

// Every failure the client sees is one of these: a typed error envelope from the API, or a synthetic
// NETWORK/INTERNAL one when the request never produced a usable envelope (docs/10 §10.5).
export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK';
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode | 'NETWORK', status: number, details: unknown = null) {
    super(`API error ${code} (${status})`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// VALIDATION_FAILED carries flattened Zod issues; forms map them back onto fields (docs/10 §10.6).
export type FieldIssues = Record<string, string[]>;

export function fieldIssuesOf(error: unknown): FieldIssues {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return {};
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null || !('issues' in details)) return {};

  const issues: unknown = details.issues;
  if (typeof issues !== 'object' || issues === null || !('fieldErrors' in issues)) return {};

  const fieldErrors: unknown = issues.fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null) return {};

  const result: FieldIssues = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (Array.isArray(messages)) {
      result[field] = messages.filter((message): message is string => typeof message === 'string');
    }
  }
  return result;
}
