import type { DocumentDetailDto } from '../../../shared/contracts/documents';
import {
  documentSignaturesSchema,
  fileSignatureDtoSchema,
} from '../../../shared/contracts/signatures';
import { okResponseSchema } from '../../../shared/contracts/users';
import { apiClient, uploadFile } from '../../shared/api';

const root = (id: string, fileId: string) => `/api/documents/${id}/files/${fileId}/signatures`;
export const signatureKey = (document: DocumentDetailDto) =>
  ['document-signatures', document.id, ...document.files.map((file) => file.id)] as const;
export const documentSignatureApi = {
  list: (id: string) =>
    apiClient.get(`/api/documents/${id}/signatures`, { schema: documentSignaturesSchema }),
  attach: (id: string, fileId: string, file: File) =>
    uploadFile(root(id, fileId), file, { schema: fileSignatureDtoSchema }),
  remove: (id: string, fileId: string, signatureId: string) =>
    apiClient.delete(`${root(id, fileId)}/${signatureId}`, { schema: okResponseSchema }),
  content: (id: string, fileId: string, signatureId: string) =>
    `${root(id, fileId)}/${signatureId}/content`,
};
