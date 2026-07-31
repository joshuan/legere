import {
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../../domain/errors/domain-error';
import {
  DocumentRepository,
  type DocumentDetail,
} from '../../domain/repositories/document.repository';
import { callerOf } from '../auth/current-user';

const DOCUMENT_KEY = 'legereDocument';

// Path ids are uuids and a malformed one answers 404, not 422 (docs/07 §7.1) — and it must never
// reach the database, which would answer with a driver error and a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestWithDocument = Request & { [DOCUMENT_KEY]?: DocumentDetail };

// Resolves the document in the path and checks that this caller may read it (docs/06 §6.4,
// docs/08 §8.5). The loaded document is attached to the request, so the use case behind the route
// works from it instead of fetching the same row again.
@Injectable()
export class DocumentAccessGuard implements CanActivate {
  constructor(private readonly documents: DocumentRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const caller = callerOf(request);
    if (caller === undefined) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');

    const id = request.params.id ?? '';
    if (!UUID.test(id)) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');

    const detail = await this.documents.findReadableById(id, caller.user);

    // 🔒 Not found, deleted, and not-allowed all answer the same way: telling a user that a document
    // exists in a library they were never granted is itself a disclosure (docs/08 §8.5).
    if (detail === null) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');

    const target: RequestWithDocument = request;
    target[DOCUMENT_KEY] = detail;
    return true;
  }
}

// @CurrentDocument() — the document the guard already loaded and authorized.
export const CurrentDocument = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request: RequestWithDocument = context.switchToHttp().getRequest<Request>();
  const document = request[DOCUMENT_KEY];
  if (document === undefined) {
    throw new Error('CurrentDocument used on a route without DocumentAccessGuard');
  }
  return document;
});
