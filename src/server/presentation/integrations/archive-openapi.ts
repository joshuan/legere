const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});
const errors = {
  '401': error('UNAUTHENTICATED: missing, expired or revoked access token/grant.'),
  '403': error('FORBIDDEN: wrong resource/scope or inactive account.'),
  '404': error('DOCUMENT_NOT_FOUND: absent, deleted, receipt or outside the personal archive.'),
  '422': error('VALIDATION_FAILED or CURSOR_SORT_MISMATCH. No unknown query fields are accepted.'),
  '429': {
    ...error('RATE_LIMITED. Retry after the specified number of seconds.'),
    headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } },
  },
};
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
function read(operationId: string, summary: string, schema: object, parameters: object[] = []) {
  return {
    operationId,
    summary,
    security: [{ personalArchiveOAuth: ['documents:read'] }],
    parameters,
    responses: {
      '200': {
        description: 'Live personal archive data; never cache this response.',
        headers: { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } },
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['data'],
              additionalProperties: false,
              properties: { data: schema },
            },
          },
        },
      },
      ...errors,
    },
  };
}
function artifact(kind: 'canonical' | 'preview') {
  const operation = read(
    kind === 'canonical' ? 'getPersonalDocumentCanonical' : 'getPersonalDocumentPreview',
    kind === 'canonical'
      ? 'Get a temporary personal document PDF URL'
      : 'Get a temporary personal document JPEG URL',
    ref('Artifact'),
    [id],
  );
  return {
    get: {
      ...operation,
      description:
        'Rechecks personal ownership and eligibility. Only this artifact’s step must be DONE. The URL lasts SIGNED_URL_TTL_SEC and remains usable until expiry after revocation. Artifact keys can be overwritten: this is the latest document, not an immutable revision. Prefer an authorized backend proxy; never persist or log signed URLs.',
      responses: {
        ...operation.responses,
        '409': error(kind === 'canonical' ? 'CANONICAL_NOT_READY' : 'DOCUMENT_UNAVAILABLE'),
      },
    },
  };
}
export const archiveOpenApiPaths = {
  '/api/integrations/archive/me': {
    get: read(
      'getPersonalArchiveSubject',
      'Identify the consenting Legere user',
      ref('ArchiveSubject'),
    ),
  },
  '/api/integrations/archive/documents': {
    get: {
      ...read(
        'listPersonalDocuments',
        'List and search the consenting user’s personal documents',
        {
          type: 'object',
          required: ['items', 'nextCursor'],
          additionalProperties: false,
          properties: {
            items: { type: 'array', items: ref('ArchiveDocument') },
            nextCursor: { type: ['string', 'null'] },
          },
        },
        [
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 300, default: '' } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string', minLength: 1, maxLength: 2048 },
          },
        ],
      ),
      description:
        'Live DOCUMENT profiles owned by the subject, without an integration namespace or library-origin pages. ADMIN and sharing do not broaden access. Filtered before pagination; createdAt DESC, id DESC. q is a trimmed case-insensitive literal substring of title or description. No wildcard expansion or highlighting. Cursors bind subject, normalized q and order. Unknown query fields are rejected.',
    },
  },
  '/api/integrations/archive/documents/{id}': {
    get: read('getPersonalDocument', 'Read an eligible personal document', ref('ArchiveDocument'), [
      id,
    ]),
  },
  '/api/integrations/archive/documents/{id}/canonical': artifact('canonical'),
  '/api/integrations/archive/documents/{id}/preview': artifact('preview'),
};
export const archiveOpenApiSchemas = {
  ArchiveSubject: {
    type: 'object',
    required: ['subject', 'displayName'],
    additionalProperties: false,
    properties: {
      subject: {
        type: 'string',
        format: 'uuid',
        description:
          'Immutable Legere user ID, stable across grants and refresh rotation. Never infer it from email or document authors.',
      },
      displayName: { type: 'string' },
    },
  },
  ArchiveDocument: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'title',
      'description',
      'createdAt',
      'documentDate',
      'pageCount',
      'documentType',
      'processing',
      'steps',
      'url',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      documentDate: { type: ['string', 'null'], format: 'date' },
      pageCount: { type: ['integer', 'null'], minimum: 0 },
      documentType: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['id', 'slug', 'name'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', format: 'uuid' },
              slug: { type: 'string' },
              name: { type: 'string' },
            },
          },
        ],
      },
      processing: { type: 'boolean' },
      steps: ref('Steps'),
      url: {
        type: 'string',
        format: 'uri',
        description:
          'Ordinary Legere document page requiring the viewer’s own session and permissions, not a public share.',
      },
    },
  },
};
export function archiveOAuthScheme(baseUrl: string) {
  const issuer = baseUrl.replace(/\/+$/, '');
  return {
    type: 'oauth2',
    description: `Authorization code with S256 PKCE, exact resource ${issuer}/api/integrations/archive and documents:read. Discover /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/api/integrations/archive. Register the backend with client_secret_basic and documents:read; exact HTTPS callback. Validate one-time state and response iss. Access <=15 minutes; rotating refresh/grant 90 days. Serialize refresh per connection; replay revokes the whole family. POST /api/oauth/revoke disconnects. No personal, MCP, namespace or cookie fallback. This permission grants no mutations or other REST access.`,
    flows: {
      authorizationCode: {
        authorizationUrl: `${issuer}/oauth/authorize`,
        tokenUrl: `${issuer}/api/oauth/token`,
        refreshUrl: `${issuer}/api/oauth/token`,
        scopes: { 'documents:read': 'Read only your personal documents and display artifacts' },
      },
    },
  };
}
