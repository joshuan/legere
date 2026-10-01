import { receiptReviewStateSchema } from '../../../shared/contracts/receipts';
import { stepStatusSchema } from '../../../shared/contracts/enums';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { type: ['string', 'null'], format: 'uuid' };
const response = (description: string, schema: object) => ({
  description,
  content: { 'application/json': { schema } },
});
const id = { name: 'id', in: 'path', required: true, schema: uuid };
function read(operationId: string, summary: string, schema: object, parameters: object[] = [id]) {
  return {
    operationId,
    summary,
    security: [{ personalReadToken: [] }],
    parameters,
    responses: {
      '200': response('The requested receipt identity, including preserved review sources.', {
        type: 'object',
        required: ['data'],
        properties: { data: schema },
      }),
      '401': response('Missing, expired or revoked credentials.', ref('Error')),
      '403': response(
        'Wrong token scope; OAuth and integration tokens do not grant receipt access.',
        ref('Error'),
      ),
      '404': response(
        'RECEIPT_NOT_FOUND: missing, explicitly deleted/converted or inaccessible receipt. Unknown page: NOT_FOUND.',
        ref('Error'),
      ),
      '422': response('Invalid input.', ref('Error')),
      '429': response('Rate limit reached. Honor Retry-After.', ref('Error')),
    },
  };
}
function artifact(kind: string) {
  return {
    get: {
      ...read(
        `getReceipt${kind[0]?.toUpperCase()}${kind.slice(1)}`,
        `Read the requested receipt's ${kind}`,
        ref('ReceiptArtifact'),
      ),
      description:
        'Preserved receipts retain their own original files and page numbering. Never follows replacementId or redirects to a combined PDF. Signed URLs are temporary capabilities; persist issuer + receipt ID, not the URL.',
    },
  };
}
export const receiptOpenApiPaths = {
  '/api/receipts/{id}': {
    get: {
      ...read(
        'getReceipt',
        'Read a receipt and its explicit replacement information',
        ref('ReceiptDetail'),
      ),
      description:
        'Owner/admin access, including REPLACED and MERGE_UNDONE receipts. The returned id, data and artifacts always belong to the requested receipt. reference.replacementId names the immediate readable replacement; follow its own reference for later decisions. MERGE_UNDONE can name two restored receipts. Related IDs are omitted when no longer readable or no longer receipts. ACTIVE receipts have no replacement. The ordinary receipt list contains only ACTIVE receipts. Reference changes update this receipt’s updatedAt, not all transitive predecessors. Explicit deletion/conversion still returns 404. No automatic update of data copied by a consumer.',
    },
  },
  '/api/receipts/{id}/original': artifact('original'),
  '/api/receipts/{id}/download': artifact('download'),
  '/api/receipts/{id}/thumbnail': artifact('thumbnail'),
  '/api/receipts/{id}/pages/{page}': {
    get: read(
      'getReceiptPage',
      'Read an original receipt page preview without following replacements',
      ref('ReceiptArtifact'),
      [id, { name: 'page', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
    ),
  },
};
export const receiptReadTokenScheme = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'legere_...',
  description:
    'A personal READ API token. Owner/admin receipt permissions apply. Session authentication also supports these routes. RECEIPTS_INGEST, integration tokens, MCP OAuth and documents:read OAuth do not grant receipt reads. Store credentials only on a trusted backend.',
};
export const receiptOpenApiSchemas = {
  ReceiptReference: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'replacementId', 'restoredReceiptIds', 'reviewId'],
    properties: {
      state: { type: 'string', enum: receiptReviewStateSchema.options },
      replacementId: {
        ...nullableUuid,
        description: 'Immediate readable replacement for REPLACED; otherwise null.',
      },
      restoredReceiptIds: {
        type: 'array',
        items: uuid,
        description:
          'Readable restored sources for MERGE_UNDONE, in original page order; otherwise empty.',
      },
      reviewId: {
        ...nullableUuid,
        description: 'Decision responsible for preservation; null for ACTIVE.',
      },
    },
  },
  ReceiptArtifact: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', format: 'uri' } },
  },
  ReceiptDetail: {
    type: 'object',
    required: [
      'id',
      'fileName',
      'mimeType',
      'ext',
      'sizeBytes',
      'pageCount',
      'previewStatus',
      'extractionStatus',
      'processing',
      'extracted',
      'processingError',
      'createdAt',
      'updatedAt',
      'owner',
      'lastEventAt',
      'sourceText',
      'reference',
    ],
    properties: {
      id: uuid,
      fileName: { type: 'string' },
      mimeType: { type: 'string' },
      ext: { type: 'string' },
      sizeBytes: { type: 'string' },
      pageCount: { type: ['integer', 'null'], minimum: 1 },
      previewStatus: { type: 'string', enum: stepStatusSchema.options },
      extractionStatus: { type: 'string', enum: stepStatusSchema.options },
      processing: { type: 'boolean' },
      extracted: {
        type: ['object', 'null'],
        required: ['schema', 'values', 'confidence'],
        properties: {
          schema: {
            type: 'object',
            required: ['slug', 'version'],
            properties: { slug: { const: 'receipt' }, version: { type: 'integer', minimum: 1 } },
          },
          values: { type: 'object', additionalProperties: true },
          confidence: { type: ['number', 'null'], minimum: 0, maximum: 100 },
        },
      },
      processingError: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      lastEventAt: { type: 'string', format: 'date-time' },
      sourceText: { type: ['string', 'null'] },
      createdVia: { type: ['object', 'null'] },
      owner: {
        type: 'object',
        required: ['id', 'displayName'],
        properties: { id: uuid, displayName: { type: 'string' } },
      },
      reference: ref('ReceiptReference'),
    },
  },
};
