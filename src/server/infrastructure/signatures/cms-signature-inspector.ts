import { createHash, timingSafeEqual } from 'node:crypto';
import * as asn1 from 'asn1js';
import {
  Certificate,
  ContentInfo,
  CryptoEngine,
  IssuerAndSerialNumber,
  SignedData,
  type RelativeDistinguishedNames,
  type SignerInfo,
} from 'pkijs';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import { gostCrypto } from 'node-gost-crypto';
import type {
  FileSignatureDto,
  SignatureReport,
  SignatureSigner,
} from '../../../shared/contracts/signatures';
import { SignatureInspector } from '../../application/ports/signature-inspector';
import { UnprocessableError } from '../../domain/errors/domain-error';

const CMS_DATA = '1.2.840.113549.1.7.1';
const CMS_SIGNED = '1.2.840.113549.1.7.2';
const CONTENT_TYPE = '1.2.840.113549.1.9.3';
const MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const SIGNING_TIME = '1.2.840.113549.1.9.5';
const SHA: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
const ALGORITHMS: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.10': 'RSA-PSS',
  '1.2.840.113549.1.1.5': 'RSA / SHA-1',
  '1.2.840.113549.1.1.11': 'RSA / SHA-256',
  '1.2.840.113549.1.1.12': 'RSA / SHA-384',
  '1.2.840.113549.1.1.13': 'RSA / SHA-512',
  '1.2.840.10045.4.3.2': 'ECDSA / SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA / SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA / SHA-512',
  '1.2.643.7.1.1.1.1': 'GOST R 34.10-2012 / 256',
  '1.2.643.7.1.1.1.2': 'GOST R 34.10-2012 / 512',
  '1.2.643.7.1.1.3.2': 'GOST R 34.10-2012 / 256',
  '1.2.643.7.1.1.3.3': 'GOST R 34.10-2012 / 512',
  '1.2.643.7.1.1.2.2': 'GOST R 34.11-2012 / 256',
  '1.2.643.7.1.1.2.3': 'GOST R 34.11-2012 / 512',
};
const DN: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '1.2.840.113549.1.9.1': 'email',
  '1.2.643.100.1': 'OGRN',
  '1.2.643.100.4': 'INN',
};
const engine = new CryptoEngine({ name: 'node', crypto: globalThis.crypto });
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(new Uint8Array(bytes)).toString('hex').toUpperCase();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const algorithmName = (oid: string) =>
  `${ALGORITHMS[oid] ?? SHA[oid]?.toUpperCase() ?? 'Unknown'} (${oid})`;

function invalid(): UnprocessableError {
  return new UnprocessableError(
    'SIGNATURE_INVALID',
    'A CMS signature with signer information is required',
  );
}

function decodeCms(bytes: Buffer): SignedData {
  try {
    const text = bytes.toString('ascii').trim();
    let der = bytes;
    if (text.startsWith('-----BEGIN')) {
      const pem =
        /^-----BEGIN (?:CMS|PKCS7|PKCS #7 SIGNED DATA)-----\s+([A-Za-z0-9+/=\s]+)-----END (?:CMS|PKCS7|PKCS #7 SIGNED DATA)-----$/.exec(
          text,
        );
      if (pem?.[1] === undefined) throw invalid();
      der = Buffer.from(pem[1].replace(/\s/g, ''), 'base64');
    } else if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
      der = Buffer.from(text.replace(/\s/g, ''), 'base64');
    }
    const decoded = asn1.fromBER(der);
    // PDF Contents commonly ends in reserved zero padding. No other trailing bytes are accepted.
    if (decoded.offset < 0 || der.subarray(decoded.offset).some((byte) => byte !== 0))
      throw invalid();
    const cms = new ContentInfo({ schema: decoded.result });
    if (cms.contentType !== CMS_SIGNED) throw invalid();
    const signed = new SignedData({ schema: cms.content });
    if (
      signed.signerInfos.length === 0 ||
      signed.signerInfos.length > 20 ||
      (signed.certificates?.length ?? 0) > 100
    )
      throw invalid();
    return signed;
  } catch {
    throw invalid();
  }
}

function distinguishedName(name: RelativeDistinguishedNames): string {
  return name.typesAndValues
    .map((entry) => {
      const block = entry.value.valueBlock;
      const value = 'value' in block && typeof block.value === 'string' ? block.value : '';
      return `${DN[entry.type] ?? entry.type}=${value}`;
    })
    .join(', ');
}

function certificateFor(signed: SignedData, signer: SignerInfo): Certificate | undefined {
  return signed.certificates?.find((certificate): certificate is Certificate => {
    if (!(certificate instanceof Certificate)) return false;
    if (signer.sid instanceof IssuerAndSerialNumber) {
      return (
        certificate.issuer.isEqual(signer.sid.issuer) &&
        certificate.serialNumber.isEqual(signer.sid.serialNumber)
      );
    }
    const identifier: unknown = signer.sid;
    if (!(identifier instanceof asn1.Primitive) && !(identifier instanceof asn1.Constructed))
      return false;
    if (identifier.idBlock.tagClass !== 3 || identifier.idBlock.tagNumber !== 0) return false;
    const sid: unknown =
      identifier instanceof asn1.Primitive ? identifier : identifier.valueBlock.value[0];
    if (!(sid instanceof asn1.Primitive) && !(sid instanceof asn1.OctetString)) return false;
    const extension = certificate.extensions?.find((ext) => ext.extnID === '2.5.29.14');
    const value =
      extension === undefined ? undefined : asn1.fromBER(extension.extnValue.getValue()).result;
    const keyId =
      value instanceof asn1.OctetString
        ? value.getValue()
        : createHash('sha1')
            .update(certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)
            .digest();
    return hex(keyId) === hex(sid.valueBlock.valueHexView);
  });
}

function attribute(signer: SignerInfo, oid: string): unknown {
  const attributes = signer.signedAttrs?.attributes.filter((item) => item.type === oid) ?? [];
  return attributes.length === 1 && attributes[0]?.values.length === 1
    ? attributes[0].values[0]
    : undefined;
}

function signingTime(signer: SignerInfo): string | null {
  const value = attribute(signer, SIGNING_TIME);
  if (!(value instanceof asn1.UTCTime) && !(value instanceof asn1.GeneralizedTime)) return null;
  const date = value.toDate();
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function gostLength(oid: string): number | null {
  if (oid === '1.2.643.7.1.1.2.2') return 256;
  if (oid === '1.2.643.7.1.1.2.3') return 512;
  return null;
}

async function digest(oid: string, content: Buffer): Promise<Buffer | null> {
  const sha = SHA[oid];
  if (sha !== undefined) return createHash(sha).update(content).digest();
  const length = gostLength(oid);
  return length === null
    ? null
    : Buffer.from(
        await gostCrypto.subtle.digest(
          {
            name: 'GOST R 34.11',
            version: 2012,
            length,
          },
          content,
        ),
      );
}

async function inspectSigner(
  signed: SignedData,
  index: number,
  content: Buffer,
): Promise<SignatureSigner> {
  const signer = signed.signerInfos[index];
  if (signer === undefined) throw invalid();
  const cert = certificateFor(signed, signer);
  const result: SignatureSigner = {
    subject: cert === undefined ? null : distinguishedName(cert.subject),
    issuer: cert === undefined ? null : distinguishedName(cert.issuer),
    serialNumber: cert === undefined ? null : hex(cert.serialNumber.valueBlock.valueHexView),
    certificateSha256:
      cert === undefined ? null : sha256(new Uint8Array(cert.toSchema().toBER(false))),
    validFrom: cert?.notBefore.value.toISOString() ?? null,
    validTo: cert?.notAfter.value.toISOString() ?? null,
    signingTime: signingTime(signer),
    digestAlgorithm: algorithmName(signer.digestAlgorithm.algorithmId),
    signatureAlgorithm: algorithmName(signer.signatureAlgorithm.algorithmId),
    verification: 'UNSUPPORTED',
    digestMatch: null,
  };
  let data = content;
  if (signer.signedAttrs !== undefined) {
    const type = attribute(signer, CONTENT_TYPE);
    const md = attribute(signer, MESSAGE_DIGEST);
    if (
      !(type instanceof asn1.ObjectIdentifier) ||
      type.valueBlock.toString() !== signed.encapContentInfo.eContentType ||
      !(md instanceof asn1.OctetString)
    )
      return { ...result, verification: 'INVALID' };
    const calculated = await digest(signer.digestAlgorithm.algorithmId, content);
    if (calculated !== null) {
      const expected = Buffer.from(md.getValue());
      result.digestMatch =
        calculated.length === expected.length && timingSafeEqual(calculated, expected);
      if (!result.digestMatch) return { ...result, verification: 'INVALID' };
    }
    // RFC 5652 §5.4: signedAttrs is encoded as SET OF, not its implicit context [0] tag.
    data = Buffer.from(signer.signedAttrs.encodedValue);
    data[0] = 0x31;
  } else if (signed.encapContentInfo.eContentType !== CMS_DATA) {
    return { ...result, verification: 'INVALID' };
  }
  if (cert === undefined) return { ...result, verification: 'NO_CERTIFICATE' };
  const length = gostLength(signer.digestAlgorithm.algorithmId);
  if (length !== null) {
    const oid = cert.subjectPublicKeyInfo.algorithm.algorithmId;
    if (
      oid !== `1.2.643.7.1.1.1.${length === 256 ? 1 : 2}` ||
      ![oid, `1.2.643.7.1.1.3.${length === 256 ? 2 : 3}`].includes(
        signer.signatureAlgorithm.algorithmId,
      )
    )
      return result;
    try {
      const algorithm = {
        name: 'GOST R 34.10',
        version: 2012,
        length,
        hash: { name: 'GOST R 34.11', version: 2012, length },
      };
      const key = await gostCrypto.subtle.importKey(
        'spki',
        cert.subjectPublicKeyInfo.toSchema().toBER(false),
        algorithm,
        false,
        ['verify'],
      );
      const valid = await gostCrypto.subtle.verify(
        algorithm,
        key,
        signer.signature.getValue(),
        data,
      );
      result.verification = valid ? 'VALID' : 'INVALID';
    } catch {
      result.verification = 'UNSUPPORTED';
    }
    return result;
  }
  if (
    SHA[signer.digestAlgorithm.algorithmId] === undefined ||
    ALGORITHMS[signer.signatureAlgorithm.algorithmId] === undefined
  )
    return result;
  try {
    // Content and mandatory attributes were checked above; verify with the certificate we matched
    // rather than asking the library to find it again (custom subject-key identifiers are legal).
    const hash = SHA[signer.digestAlgorithm.algorithmId]?.replace('sha', 'SHA-');
    const valid = await engine.verifyWithPublicKey(
      Uint8Array.from(data).buffer,
      signer.signature,
      cert.subjectPublicKeyInfo,
      signer.signatureAlgorithm,
      hash,
    );
    result.verification = valid ? 'VALID' : 'INVALID';
  } catch (error: unknown) {
    result.verification =
      error instanceof Error &&
      (error.name === 'NotSupportedError' ||
        /unsupported|not supported|unrecognized|unknown.*curve/i.test(error.message))
        ? 'UNSUPPORTED'
        : 'INVALID';
  }
  return result;
}

async function report(
  signed: SignedData,
  content: Buffer,
  coversWholeFile: boolean | null,
): Promise<SignatureReport> {
  const signers: SignatureSigner[] = [];
  for (let index = 0; index < signed.signerInfos.length; index += 1)
    signers.push(await inspectSigner(signed, index, content));
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    signers,
    coversWholeFile,
    trust: 'NOT_CHECKED',
  };
}

export class CmsSignatureInspector extends SignatureInspector {
  async detached(signature: Buffer, original: Buffer): Promise<SignatureReport> {
    const signed = decodeCms(signature);
    if (signed.encapContentInfo.eContent !== undefined) throw invalid();
    return report(signed, original, null);
  }

  async pdf(original: Buffer) {
    const signatures: FileSignatureDto[] = [];
    try {
      const pdf = await PDFDocument.load(original, {
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
      const dictionaries: PDFDict[] = [];
      const visited = new Set<object>();
      const visit = (object: unknown, depth: number): void => {
        if (depth > 50 || typeof object !== 'object' || object === null || visited.has(object))
          return;
        visited.add(object);
        if (object instanceof PDFDict) {
          if (object.has(PDFName.of('ByteRange')) && object.has(PDFName.of('Contents')))
            dictionaries.push(object);
          for (const value of object.values()) visit(value, depth + 1);
        } else if (object instanceof PDFArray) {
          for (let i = 0; i < object.size(); i += 1) visit(object.get(i), depth + 1);
        }
      };
      for (const [, object] of pdf.context.enumerateIndirectObjects()) visit(object, 0);
      if (dictionaries.length > 20) return { discovery: 'UNSUPPORTED' as const, signatures };
      for (const dictionary of dictionaries) {
        const ranges = dictionary.lookup(PDFName.of('ByteRange'));
        const contents = dictionary.lookup(PDFName.of('Contents'));
        if (
          !(ranges instanceof PDFArray) ||
          ranges.size() !== 4 ||
          (!(contents instanceof PDFHexString) && !(contents instanceof PDFString))
        )
          throw invalid();
        const numbers = Array.from({ length: 4 }, (_, i) => ranges.lookup(i));
        const [start, firstEnd, secondStart, secondSize] = numbers.map((value) =>
          value instanceof PDFNumber ? value.asNumber() : NaN,
        );
        if (
          start !== 0 ||
          firstEnd === undefined ||
          secondStart === undefined ||
          secondSize === undefined ||
          ![firstEnd, secondStart, secondSize].every(Number.isSafeInteger) ||
          firstEnd <= 0 ||
          secondStart <= firstEnd ||
          secondSize < 0 ||
          secondStart + secondSize > original.length
        )
          throw invalid();
        const gap = original.subarray(firstEnd, secondStart).toString('latin1');
        let excluded: Uint8Array;
        if (/^<[\da-fA-F\s]+>$/.test(gap))
          excluded = PDFHexString.of(gap.slice(1, -1).replace(/\s/g, '')).asBytes();
        else if (gap.startsWith('(') && gap.endsWith(')'))
          excluded = PDFString.of(gap.slice(1, -1)).asBytes();
        else throw invalid();
        if (!Buffer.from(excluded).equals(Buffer.from(contents.asBytes()))) throw invalid();
        const signature = Buffer.from(contents.asBytes());
        const signed = decodeCms(signature);
        // PDF CMS must sign ByteRange content, never an unrelated encapsulated payload.
        if (signed.encapContentInfo.eContent !== undefined) throw invalid();
        const data = Buffer.concat([
          original.subarray(0, firstEnd),
          original.subarray(secondStart, secondStart + secondSize),
        ]);
        signatures.push({
          id: null,
          source: 'EMBEDDED',
          name: `PDF #${signatures.length + 1}`,
          contentHash: sha256(signature),
          sizeBytes: String(signature.length),
          createdAt: null,
          report: await report(signed, data, secondStart + secondSize === original.length),
        });
      }
      return { discovery: 'COMPLETE' as const, signatures };
    } catch (error: unknown) {
      return {
        discovery:
          error instanceof Error && error.message.includes('encrypted')
            ? ('UNSUPPORTED' as const)
            : ('ERROR' as const),
        signatures,
      };
    }
  }
}
