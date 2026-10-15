import { createHash } from 'node:crypto';
import * as asn1 from 'asn1js';
import {
  AlgorithmIdentifier,
  Attribute,
  AttributeTypeAndValue,
  Certificate,
  ContentInfo,
  CryptoEngine,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
} from 'pkijs';
import { PDFDocument, PDFHexString } from 'pdf-lib';
import { gostCrypto } from 'node-gost-crypto';

const engine = new CryptoEngine({ name: 'node-test', crypto: globalThis.crypto });

// All identities and content are synthetic. Private downloaded extracts are never test fixtures.
export async function signatureFixture(gost = false) {
  const keys = await globalThis.crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const certificate = new Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1.Integer({ value: 42 });
  const name = new AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1.Utf8String({ value: 'Synthetic signing authority' }),
  });
  certificate.subject.typesAndValues.push(name);
  certificate.issuer.typesAndValues.push(name);
  certificate.notBefore.value = new Date('2025-01-01T00:00:00Z');
  certificate.notAfter.value = new Date('2035-01-01T00:00:00Z');
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
  await certificate.sign(keys.privateKey, 'SHA-256', engine);
  const gostAlgorithm = {
    name: 'GOST R 34.10',
    id: 'id-tc26-gost3410-12-256',
    version: 2012,
    length: 256,
    namedCurve: 'S-256-A',
    hash: { name: 'GOST R 34.11', version: 2012, length: 256 },
  };
  const gostKeys = gost
    ? await gostCrypto.subtle.generateKey(gostAlgorithm, true, ['sign', 'verify'])
    : null;
  if (gostKeys !== null) {
    const spki = await gostCrypto.subtle.exportKey('spki', gostKeys.publicKey);
    certificate.subjectPublicKeyInfo.fromSchema(asn1.fromBER(spki).result);
    // The issuer's certificate signature is intentionally irrelevant: chain trust is not checked.
    certificate.tbsView = new Uint8Array(certificate.encodeTBS().toBER(false));
  }

  const signedData = async (content: Buffer, certs = true) => {
    const signer = new SignerInfo({
      version: 1,
      sid: new IssuerAndSerialNumber({
        issuer: certificate.issuer,
        serialNumber: certificate.serialNumber,
      }),
    });
    const signed = new SignedData({
      version: 1,
      encapContentInfo: new EncapsulatedContentInfo({ eContentType: ContentInfo.DATA }),
      certificates: certs ? [certificate] : [],
      signerInfos: [signer],
    });
    const digest =
      gostKeys === null
        ? createHash('sha256').update(content).digest()
        : Buffer.from(await gostCrypto.subtle.digest(gostAlgorithm.hash, content));
    signer.signedAttrs = new SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new Attribute({
          type: '1.2.840.113549.1.9.3',
          values: [new asn1.ObjectIdentifier({ value: ContentInfo.DATA })],
        }),
        new Attribute({
          type: '1.2.840.113549.1.9.4',
          values: [new asn1.OctetString({ valueHex: Uint8Array.from(digest).buffer })],
        }),
        new Attribute({
          type: '1.2.840.113549.1.9.5',
          values: [new asn1.UTCTime({ valueDate: new Date('2026-10-15T10:00:00Z') })],
        }),
      ],
    });
    if (gostKeys === null) {
      await signed.sign(keys.privateKey, 0, 'SHA-256', Uint8Array.from(content).buffer, engine);
    } else {
      signer.digestAlgorithm = new AlgorithmIdentifier({ algorithmId: '1.2.643.7.1.1.2.2' });
      signed.digestAlgorithms.push(signer.digestAlgorithm);
      signer.signatureAlgorithm = new AlgorithmIdentifier({ algorithmId: '1.2.643.7.1.1.1.1' });
      const attrs = new Uint8Array(signer.signedAttrs.toSchema().toBER(false));
      attrs[0] = 0x31;
      signer.signature = new asn1.OctetString({
        valueHex: await gostCrypto.subtle.sign(gostAlgorithm, gostKeys.privateKey, attrs),
      });
    }
    return signed;
  };
  const encode = (signed: SignedData) =>
    Buffer.from(
      new ContentInfo({
        contentType: ContentInfo.SIGNED_DATA,
        content: signed.toSchema(true),
      })
        .toSchema()
        .toBER(false),
    );
  const sign = async (content: Buffer, certs = true) => encode(await signedData(content, certs));
  return { sign, signedData, encode, certificate };
}

export async function signedPdf(sign: (bytes: Buffer) => Promise<Buffer>) {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const signature = pdf.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 1111111111, 2222222222, 3333333333],
    Contents: PDFHexString.of('0'.repeat(16000)),
  });
  pdf.catalog.set(
    pdf.context.obj('Perms'),
    pdf.context.obj({ DocMDP: pdf.context.register(signature) }),
  );
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const marker = bytes.indexOf('/Contents <');
  const start = marker + '/Contents '.length;
  const end = bytes.indexOf('>', start) + 1;
  const range = `[ 0 ${String(start).padStart(10, '0')} ${String(end).padStart(10, '0')} ${String(bytes.length - end).padStart(10, '0')} ]`;
  const oldRange = '[ 0 1111111111 2222222222 3333333333 ]';
  bytes.write(range, bytes.indexOf(oldRange), 'ascii');
  const cms = await sign(Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]));
  bytes.write(cms.toString('hex').padEnd(16000, '0'), start + 1, 'ascii');
  return bytes;
}
