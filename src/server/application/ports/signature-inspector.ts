import type { FileSignatureDto, SignatureReport } from '../../../shared/contracts/signatures';

export abstract class SignatureInspector {
  abstract detached(signature: Buffer, original: Buffer): Promise<SignatureReport>;
  abstract pdf(original: Buffer): Promise<{
    discovery: 'COMPLETE' | 'UNSUPPORTED' | 'ERROR';
    signatures: FileSignatureDto[];
  }>;
}
