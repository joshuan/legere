import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { MimeEmailParser } from './mime-email-parser';

const parser = new MimeEmailParser();
const headers = 'From: Sender <from@example.com>\r\nTo: to@example.com\r\n';

describe('MIME email decoding', () => {
  it('decodes folded encoded headers, quoted-printable and legacy charsets', async () => {
    const source =
      headers +
      'Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n =?UTF-8?B?INC80LjRgA==?=\r\n' +
      'Date: Tue, 06 Oct 2026 10:30:00 +0200\r\n' +
      'Content-Type: text/plain; charset=windows-1251\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=CF=F0=E8=E2=E5=F2';
    const result = await parser.parse(Readable.from([Buffer.from(source)]));
    expect(result.fields.subject).toBe('Привет мир');
    expect(result.fields.sentAt).toBe('2026-10-06T08:30:00.000Z');
    expect(result.markdown).toContain('Привет');
  });

  it('prefers the plain alternative and inventories attachments without interpreting their bytes', async () => {
    const source =
      headers +
      'Subject: Multipart\r\nContent-Type: multipart/mixed; boundary=outer\r\n\r\n' +
      '--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n' +
      '--inner\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from('Plain body').toString('base64') +
      '\r\n' +
      '--inner\r\nContent-Type: text/html\r\n\r\n<p>HTML alternative</p>\r\n--inner--\r\n' +
      '--outer\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="payload.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--outer--\r\n';
    const result = await parser.parse(Buffer.from(source));
    expect(result.markdown).toContain('Plain body');
    expect(result.markdown).not.toContain('HTML alternative');
    expect(result.fields.attachments).toEqual([
      { name: 'payload.bin', contentType: 'application/octet-stream', sizeBytes: 4 },
    ]);
  });

  it('converts HTML-only messages to text and never renders active or remote resources', async () => {
    const result = await parser.parse(
      Buffer.from(
        headers +
          'Subject: <script>alert(1)</script>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello &amp; goodbye</p><script>alert(2)</script><img src="https://example.com/track"><style>body {display:none}</style>',
      ),
    );
    expect(result.markdown).toContain('Hello & goodbye');
    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('<img');
    expect(result.html).not.toContain('alert(2)');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('keeps hostile Markdown literal and supports messages without a body', async () => {
    const result = await parser.parse(Buffer.from(headers + 'Subject: Empty\r\n\r\n'));
    expect(result.markdown).toContain('Subject: Empty');
    const fenced = await parser.parse(
      Buffer.from(headers + 'Subject: Fence\r\n\r\n```\n<script>evil</script>'),
    );
    expect(fenced.markdown.startsWith('````text')).toBe(true);
    expect(fenced.html).toContain('&lt;script&gt;');
  });

  it('rejects headerless input and excessive decoded HTML', async () => {
    await expect(parser.parse(Buffer.from('not a message'))).rejects.toThrow('Invalid EML');
    await expect(
      parser.parse(
        Buffer.from(headers + 'Content-Type: text/html\r\n\r\n' + 'x'.repeat(8 * 1024 * 1024 + 1)),
      ),
    ).rejects.toThrow();
  });
});
