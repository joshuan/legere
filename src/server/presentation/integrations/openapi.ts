import { archiveOpenApiPaths, archiveOpenApiSchemas, archiveOAuthScheme } from './archive-openapi';
import { stepStatusSchema } from '../../../shared/contracts/enums';
// Public contract for service integrations. Responses are verified against these schemas in e2e.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const envelope = (schema: object) => ({
  type: 'object',
  required: ['data'],
  properties: { data: schema },
});
const response = (description: string, schema: object) => ({
  description,
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => response(description, ref('Error'));
const errors = {
  '401': errorResponse('Missing, expired or revoked bearer token.'),
  '403': errorResponse('The credential is not an integration token.'),
  '404': errorResponse(
    'Document absent, deleted or outside this integration. No existence disclosure.',
  ),
  '422': errorResponse('Invalid UUID, cursor, limit, filename or other input.'),
  '429': errorResponse('Rate limit reached. Honor Retry-After.'),
};
const documentParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const artifact = (kind: 'canonical' | 'preview') => ({
  get: {
    operationId: kind === 'canonical' ? 'getCanonicalPdf' : 'getJpegPreview',
    summary:
      kind === 'canonical'
        ? 'Get a temporary canonical PDF URL'
        : 'Get a temporary first-page JPEG URL',
    description:
      'Fetch server-side using the integration token, then put data.url in an iframe or img. The URL is a temporary bearer capability; never store it as the document identity. Request a fresh URL after expiresAt. It remains usable until expiry even if the integration is revoked.',
    parameters: [documentParameter],
    responses: {
      '200': response('Signed artifact URL.', envelope(ref('Artifact'))),
      ...errors,
      '409': errorResponse(
        'Processing has not produced this artifact yet. Poll document.steps; retry when this step is DONE.',
      ),
    },
  },
});

export function integrationOpenApi(baseUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Legere service integrations',
      version: '1.1.0',
      description:
        'Create a named integration in Settings, then issue its token. Keep the token in your service backend. All endpoints are restricted to this integration and its owning user, even when the owner is an administrator. Rotation preserves the namespace: issue a new token on the same integration and revoke the old token. This contract covers the external service API; browser/account endpoints and the MCP JSON-RPC protocol are separate. MCP OAuth discovery: /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/api/mcp; MCP URL: /api/mcp, scope mcp:read. Existing personal documents use the independent /api/integrations/archive resource and documents:read OAuth permission; discover /.well-known/oauth-protected-resource/api/integrations/archive.',
    },
    servers: [{ url: baseUrl.replace(/\/+$/, '') }],
    security: [{ integrationToken: [] }],
    paths: {
      ...archiveOpenApiPaths,
      '/api/integrations/documents': {
        post: {
          operationId: 'uploadDocument',
          summary: 'Upload a document, or resolve a duplicate within this integration',
          description:
            'Send the file as raw request bytes, not multipart or base64. The filename is percent-encoded UTF-8 in X-Legere-Filename. Format is detected from bytes. Processing is asynchronous. Always save data.document.id and optionally data.document.url. Both a new upload and a duplicate return 201; data.created distinguishes them. A duplicate owned elsewhere is a 409 with no document ID. Concurrent retries return the same ID.',
          parameters: [
            {
              name: 'X-Legere-Filename',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              example: 'Lease%202026.pdf',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            '201': response(
              'New or already uploaded document.',
              envelope({
                type: 'object',
                required: ['document', 'created'],
                properties: { document: ref('Document'), created: { type: 'boolean' } },
              }),
            ),
            ...errors,
            '409': errorResponse(
              'DOCUMENT_DUPLICATE or ARCHIVE_KIND_CONFLICT: these bytes have a home outside this integration. No existing ID is disclosed.',
            ),
            '413': errorResponse(
              'Upload exceeds the instance UPLOAD_MAX_BYTES setting (default 100 MiB).',
            ),
            '415': errorResponse('Unsupported file format.'),
          },
        },
        get: {
          operationId: 'listDocuments',
          summary: 'List this integration’s active documents',
          description:
            'Newest first. Treat cursors as opaque; supply nextCursor until null. Additional query parameters are rejected. Documents converted to receipts no longer appear here.',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string', minLength: 1 } },
          ],
          responses: {
            '200': response(
              'One page of documents.',
              envelope({
                type: 'object',
                required: ['items', 'nextCursor'],
                properties: {
                  items: { type: 'array', items: ref('Document') },
                  nextCursor: { type: ['string', 'null'] },
                },
              }),
            ),
            ...errors,
          },
        },
      },
      '/api/integrations/documents/{id}': {
        get: {
          operationId: 'getDocument',
          summary: 'Read document metadata and processing state',
          parameters: [documentParameter],
          responses: {
            '200': response('Document in this integration.', envelope(ref('Document'))),
            ...errors,
          },
        },
      },
      '/api/integrations/documents/{id}/canonical': artifact('canonical'),
      '/api/integrations/documents/{id}/preview': artifact('preview'),
    },
    components: {
      securitySchemes: {
        personalArchiveOAuth: archiveOAuthScheme(baseUrl),
        integrationToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'legere_...',
          description:
            'A Settings → Integrations token, not a personal READ/INGEST token or MCP OAuth token.',
        },
      },
      schemas: {
        ...archiveOpenApiSchemas,
        Document: {
          type: 'object',
          required: [
            'id',
            'title',
            'description',
            'createdAt',
            'documentDate',
            'pageCount',
            'processing',
            'steps',
            'url',
            'ownerId',
            'createdVia',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: ['string', 'null'] },
            createdAt: { type: 'string', format: 'date-time' },
            documentDate: { type: ['string', 'null'] },
            pageCount: { type: ['integer', 'null'], minimum: 0 },
            processing: { type: 'boolean' },
            steps: ref('Steps'),
            url: {
              type: 'string',
              format: 'uri',
              description:
                'Stable Legere page link. Opening it requires a Legere user session with access; it is not a public sharing link.',
            },
            ownerId: { type: 'string', format: 'uuid' },
            createdVia: { anyOf: [ref('AgentIdentity'), { type: 'null' }] },
          },
        },
        AgentIdentity: {
          type: 'object',
          required: ['kind', 'id', 'name'],
          properties: {
            kind: { type: 'string', enum: ['API_TOKEN', 'OAUTH', 'INTEGRATION'] },
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            clientId: { type: 'string' },
          },
        },
        Steps: {
          type: 'object',
          required: ['canonical', 'preview', 'markdown', 'analysis', 'fields', 'vectorization'],
          properties: Object.fromEntries(
            ['canonical', 'preview', 'markdown', 'analysis', 'fields', 'vectorization'].map(
              (name) => [name, ref('StepStatus')],
            ),
          ),
        },
        StepStatus: { type: 'string', enum: stepStatusSchema.options },
        Artifact: {
          type: 'object',
          required: ['url', 'expiresAt', 'contentType'],
          properties: {
            url: { type: 'string', format: 'uri' },
            expiresAt: { type: 'string', format: 'date-time' },
            contentType: { type: 'string', enum: ['application/pdf', 'image/jpeg'] },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'details'],
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
            },
          },
        },
      },
    },
  };
}
