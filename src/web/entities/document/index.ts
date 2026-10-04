// Public API of the document entity (docs/10 §10.1).
export {
  documentApi,
  documentFiles,
  documentKeys,
  type DocumentFilters,
  type DocumentListOptions,
} from './api';
export { useRecentDocuments } from './recent';
export { SearchResultRow } from './search-result-row';
export { isViewerTab, VIEWER_TABS, type ViewerTab } from './viewer-tab';
export { DocumentImage } from './document-image';

export { documentOcrApi } from './ocr-api';
