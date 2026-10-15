import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { OctetString, Primitive, Constructed } from 'asn1js';
import { signatureFixture, signedPdf } from '../../../../test/helpers/signatures';
import { CmsSignatureInspector } from './cms-signature-inspector';

describe('CMS signatures of original bytes', () => {
  const inspector = new CmsSignatureInspector();
  const original = Buffer.from('Synthetic original with an electronic signature');
  let fixture: Awaited<ReturnType<typeof signatureFixture>>;
  beforeAll(async () => {
    fixture = await signatureFixture();
  });

  it('verifies RSA, preserves certificate identity, hashes and claimed time, without claiming trust', async () => {
    const report = await inspector.detached(await fixture.sign(original), original);
    expect(report).toMatchObject({
      version: 1,
      trust: 'NOT_CHECKED',
      coversWholeFile: null,
      signers: [
        {
          verification: 'VALID',
          digestMatch: true,
          serialNumber: '2A',
          subject: 'CN=Synthetic signing authority',
          signingTime: '2026-10-15T10:00:00.000Z',
        },
      ],
    });
    expect(report.signers[0]?.certificateSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('verifies GOST 2012 CMS and rejects changed original bytes and a corrupt signature', async () => {
    const gost = await signatureFixture(true);
    const signature = await gost.sign(original);
    expect((await inspector.detached(signature, original)).signers[0]?.verification).toBe('VALID');
    expect((await inspector.detached(signature, Buffer.from('Changed'))).signers[0]).toMatchObject({
      verification: 'INVALID',
      digestMatch: false,
    });
    const broken = Buffer.from(signature);
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 1;
    expect((await inspector.detached(broken, original)).signers[0]?.verification).toBe('INVALID');
  });
  it('rejects a signature over a different original', async () => {
    expect(
      (await inspector.detached(await fixture.sign(original), Buffer.from('Changed'))).signers[0],
    ).toMatchObject({ verification: 'INVALID', digestMatch: false });
  });
  it('distinguishes missing certificates and unsupported algorithms from valid signatures', async () => {
    expect(
      (await inspector.detached(await fixture.sign(original, false), original)).signers[0]
        ?.verification,
    ).toBe('NO_CERTIFICATE');
    const signed = await fixture.signedData(original);
    const signer = signed.signerInfos[0];
    if (signer === undefined) throw new Error('Fixture signer missing');
    signer.signatureAlgorithm.algorithmId = '1.2.3.4.5';
    expect(
      (await inspector.detached(fixture.encode(signed), original)).signers[0]?.verification,
    ).toBe('UNSUPPORTED');
  });
  it('parses PEM and base64 containers without changing the signed bytes', async () => {
    const bytes = await fixture.sign(original);
    for (const encoded of [
      bytes.toString('base64'),
      `-----BEGIN CMS-----\n${bytes.toString('base64')}\n-----END CMS-----`,
    ]) {
      expect(
        (await inspector.detached(Buffer.from(encoded), original)).signers[0]?.verification,
      ).toBe('VALID');
    }
  });
  it('matches signer certificates identified by primitive or constructed subject-key identifiers', async () => {
    const keyId = createHash('sha1')
      .update(fixture.certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)
      .digest();
    for (const sid of [
      new Primitive({
        idBlock: { tagClass: 3, tagNumber: 0 },
        valueHex: Uint8Array.from(keyId).buffer,
      }),
      new Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: [new OctetString({ valueHex: Uint8Array.from(keyId).buffer })],
      }),
    ]) {
      const signed = await fixture.signedData(original);
      const signer = signed.signerInfos[0];
      if (signer === undefined) throw new Error('Fixture signer missing');
      signer.version = 3;
      signer.sid = sid;
      expect(
        (await inspector.detached(fixture.encode(signed), original)).signers[0]?.verification,
      ).toBe('VALID');
    }
  });
  it('rejects arbitrary uploads, truncated CMS, certificate-only bags and attached CMS', async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('not a signature'),
      (await fixture.sign(original)).subarray(0, 30),
    ]) {
      await expect(inspector.detached(bytes, original)).rejects.toMatchObject({
        code: 'SIGNATURE_INVALID',
      });
    }
    const signed = await fixture.signedData(original);
    signed.encapContentInfo.eContent = new OctetString({
      valueHex: Uint8Array.from(original).buffer,
    });
    await expect(inspector.detached(fixture.encode(signed), original)).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
    delete signed.encapContentInfo.eContent;
    signed.signerInfos = [];
    await expect(inspector.detached(fixture.encode(signed), original)).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
  });
  it('reports every signer, including a signer whose cryptographic signature fails', async () => {
    const signed = await fixture.signedData(original);
    const other = await fixture.signedData(original);
    const signer = other.signerInfos[0];
    if (signer === undefined) throw new Error('Fixture signer missing');
    signer.signature.valueBlock.valueHexView[0] =
      (signer.signature.valueBlock.valueHexView[0] ?? 0) ^ 1;
    signed.signerInfos.push(signer);
    expect(
      (await inspector.detached(fixture.encode(signed), original)).signers.map(
        (signer) => signer.verification,
      ),
    ).toEqual(['VALID', 'INVALID']);
  });
  it('discovers embedded PDF signatures using the exact ByteRange bytes', async () => {
    const pdf = await signedPdf(fixture.sign);
    const inspected = await inspector.pdf(pdf);
    expect(inspected).toMatchObject({
      discovery: 'COMPLETE',
      signatures: [
        {
          source: 'EMBEDDED',
          report: {
            coversWholeFile: true,
            signers: [{ verification: 'VALID' }],
          },
        },
      ],
    });
    const changed = Buffer.from(pdf);
    const marker = changed.indexOf('/MediaBox');
    changed[marker + 1] = 'm'.charCodeAt(0);
    expect((await inspector.pdf(changed)).signatures[0]?.report.signers[0]?.verification).toBe(
      'INVALID',
    );
    const extended = Buffer.concat([pdf, Buffer.from('\n% Later unsigned revision\n')]);
    expect((await inspector.pdf(extended)).signatures[0]?.report).toMatchObject({
      coversWholeFile: false,
      signers: [{ verification: 'VALID' }],
    });
  });
  it('refuses ranges that omit bytes other than Contents', async () => {
    const pdf = await signedPdf(fixture.sign);
    const range = /\/ByteRange \[ 0 (\d+)/.exec(pdf.toString('latin1'));
    if (range?.[1] === undefined || range.index === undefined)
      throw new Error('Fixture range missing');
    pdf.write(
      String(Number(range[1]) - 1).padStart(10, '0'),
      range.index + '/ByteRange [ 0 '.length,
      'ascii',
    );
    expect(await inspector.pdf(pdf)).toMatchObject({ discovery: 'ERROR', signatures: [] });
  });
  it('distinguishes an unsigned PDF from unreadable PDF bytes', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    expect(await inspector.pdf(Buffer.from(await pdf.save()))).toEqual({
      discovery: 'COMPLETE',
      signatures: [],
    });
    expect((await inspector.pdf(Buffer.from('bad pdf'))).discovery).toBe('ERROR');
  });
});
