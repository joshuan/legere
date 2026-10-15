import { z } from 'zod';

export const MAX_SIGNATURE_BYTES = 5 * 1024 * 1024;
export const MAX_SIGNATURES_PER_FILE = 20;

export const signatureVerificationSchema = z.enum([
  'VALID',
  'INVALID',
  'UNSUPPORTED',
  'NO_CERTIFICATE',
]);
export const signatureSignerSchema = z.object({
  subject: z.string().nullable(),
  issuer: z.string().nullable(),
  serialNumber: z.string().nullable(),
  certificateSha256: z.string().nullable(),
  validFrom: z.string().datetime().nullable(),
  validTo: z.string().datetime().nullable(),
  signingTime: z.string().datetime().nullable(),
  digestAlgorithm: z.string(),
  signatureAlgorithm: z.string(),
  verification: signatureVerificationSchema,
  digestMatch: z.boolean().nullable(),
});
export const signatureReportSchema = z.object({
  version: z.literal(1),
  checkedAt: z.string().datetime(),
  signers: z.array(signatureSignerSchema).min(1),
  // Null for detached signatures. False identifies a signed earlier PDF revision.
  coversWholeFile: z.boolean().nullable(),
  trust: z.literal('NOT_CHECKED'),
});
export const fileSignatureDtoSchema = z.object({
  id: z.string().uuid().nullable(),
  source: z.enum(['DETACHED', 'EMBEDDED']),
  name: z.string(),
  contentHash: z.string(),
  sizeBytes: z.string(),
  createdAt: z.string().datetime().nullable(),
  report: signatureReportSchema,
});
export const originalSignaturesSchema = z.object({
  fileId: z.string().uuid(),
  fileName: z.string(),
  originalHash: z.string(),
  discovery: z.enum(['COMPLETE', 'UNAVAILABLE', 'UNSUPPORTED', 'ERROR']),
  signatures: z.array(fileSignatureDtoSchema),
});
export const documentSignaturesSchema = z.object({ files: z.array(originalSignaturesSchema) });

export type SignatureSigner = z.infer<typeof signatureSignerSchema>;
export type SignatureReport = z.infer<typeof signatureReportSchema>;
export type FileSignatureDto = z.infer<typeof fileSignatureDtoSchema>;
export type OriginalSignatures = z.infer<typeof originalSignaturesSchema>;
export type DocumentSignatures = z.infer<typeof documentSignaturesSchema>;
