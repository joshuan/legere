// Public API of the shared api slice (docs/10 §10.1).
export { apiClient, request, uploadFile, type RequestOptions, type UploadProgress } from './client';
export { ApiError, isApiError, fieldIssuesOf, type FieldIssues } from './api-error';
export { ERROR_MESSAGE_KEYS, messageKeyFor } from './error-messages';
export { listAllPages, type CatalogueArrangement } from './catalogue-pages';
